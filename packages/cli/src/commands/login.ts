import { createApi } from '../api';
import {
  accountFor,
  assertSecureTransport,
  defaultMachineName,
  defaultMcpUrl,
  loadConfig,
  resolveApiUrl,
  saveConfig,
} from '../config';
import type { Ctx } from '../context';
import { pollForToken } from '../device';
import { UsageError } from '../errors';
import type { Output } from '../output';
import { backendLabel, SecretStore } from '../secrets';

export interface LoginOptions {
  api?: string;
  client?: string;
  machine?: string;
  browser: boolean;
}

export async function login(ctx: Ctx, out: Output, opts: LoginOptions): Promise<void> {
  const cfg = await loadConfig(ctx);
  const apiUrl = resolveApiUrl(ctx, cfg, opts.api);
  assertSecureTransport(ctx, apiUrl);
  const client = (opts.client ?? 'cli').trim();
  const machine = (opts.machine ?? defaultMachineName(ctx)).trim();
  if (!client || client.length > 40) throw new UsageError('--client must be 1 to 40 characters.');
  if (!machine || machine.length > 80)
    throw new UsageError('--machine must be 1 to 80 characters.');

  const account = accountFor(apiUrl);
  const store = new SecretStore(ctx);
  const previous = await store.get(account);
  const previousKey = cfg.api_url === apiUrl ? cfg.key : undefined;
  if (previous) out.registerSecret(previous.secret, previousKey?.prefix);

  const api = createApi(ctx, apiUrl);
  const start = await api.startDevice({ client, machine });

  out.line(`Signing in to ${out.c.bold(apiUrl)} as ${out.c.bold(machine)} (${client}).`);
  out.line();
  out.line(`  1. Open      ${out.c.cyan(start.verification_uri)}`);
  out.line(`  2. Confirm   ${out.c.bold(start.user_code)}`);
  out.line();
  if (opts.browser && ctx.env.SECOND_BRAIN_NO_BROWSER !== '1') {
    const opened = await ctx.openUrl(start.verification_uri_complete || start.verification_uri);
    out.line(
      out.c.dim(
        opened
          ? 'Opened your browser. Check that the code matches.'
          : 'Could not open a browser; open the link above.',
      ),
    );
  }
  const minutes = Math.max(1, Math.round(start.expires_in / 60));
  out.line(
    out.c.dim(`Waiting for approval (the code expires in ${minutes} min, Ctrl-C to cancel)…`),
  );

  let lastNotice = '';
  const token = await pollForToken(api, start, {
    sleep: ctx.sleep,
    now: ctx.now,
    onEvent(e) {
      const notice =
        e.type === 'retry'
          ? `Having trouble reaching the server (${e.reason}); retrying in ${e.waitS}s.`
          : e.type === 'slow_down'
            ? `Server asked to slow down; polling every ${e.intervalS}s.`
            : '';
      if (notice && notice !== lastNotice) out.warn(notice);
      lastNotice = notice;
    },
  });
  out.registerSecret(token.secret, token.key.prefix);

  const saved = await store.set(account, token.secret);
  if (saved.warning) out.warn(saved.warning);

  await saveConfig(ctx, {
    ...cfg,
    api_url: apiUrl,
    mcp_url: token.mcp_url || defaultMcpUrl(apiUrl),
    key: {
      id: token.key.id,
      prefix: token.key.prefix,
      label: token.key.label,
      scopes: token.key.scopes,
      client: token.key.client,
      machine: token.key.machine,
      project: token.key.project,
    },
    // Connections made against another server no longer apply.
    connections: cfg.api_url === apiUrl ? cfg.connections : undefined,
  });

  // The old login key for this server is replaced; revoke it so keys don't pile up.
  const inUse = Object.values(cfg.connections ?? {}).some((c) => c.key_id === previousKey?.id);
  if (previous && previousKey && previousKey.id !== token.key.id && inUse) {
    out.warn(
      `The previous key ${previousKey.prefix}… is still used by a connected assistant, so it was kept.`,
    );
  } else if (previous && previousKey && previousKey.id !== token.key.id) {
    await createApi(ctx, apiUrl, token.secret)
      .revokeKey(previousKey.id)
      .then(() => out.line(out.c.dim(`Revoked the previous key ${previousKey.prefix}….`)))
      .catch(() =>
        out.warn(
          `Could not revoke the previous key ${previousKey.prefix}…; revoke it in the web app.`,
        ),
      );
  }

  out.line();
  out.success(
    `Signed in. Key ${out.c.bold(`${token.key.prefix}…`)} (${token.key.scopes.join(', ')}) is stored in ${backendLabel(ctx, saved.backend)}.`,
  );
  out.line(`Next: connect an assistant, e.g. ${out.c.cyan('brain connect claude-code')}`);
}
