import { ApiError } from '../api';
import { CLIENT_NAMES, SERVER_NAME, resolveTarget, type ClientId, type Target } from '../clients';
import { defaultMachineName, saveConfig } from '../config';
import type { Ctx } from '../context';
import { CliError } from '../errors';
import { applyServerMerge, planServerMerge, type MergePlan } from '../jsonfile';
import { shellQuote, tildify, type Output } from '../output';
import { requireSession, type Session } from '../session';

export interface ConnectOptions {
  api?: string;
  dryRun: boolean;
  /** Print snippets/commands with the real key when we cannot apply them ourselves. */
  showSecret: boolean;
  /** Use this machine's login key instead of creating a dedicated key for the client. */
  reuseKey: boolean;
  /** Override the client's config file path. */
  config?: string;
  machine?: string;
}

interface UsableKey {
  id: string;
  prefix: string;
  secret: string;
  minted: boolean;
}

const NEW_KEY_PLACEHOLDER = '<new-api-key>';

export async function connect(
  ctx: Ctx,
  out: Output,
  client: ClientId,
  opts: ConnectOptions,
): Promise<void> {
  const s = await requireSession(ctx, out, opts.api);
  const target = resolveTarget(ctx, client, { mcpUrl: s.mcpUrl, configFile: opts.config });
  const name = CLIENT_NAMES[client];
  const machine = (opts.machine ?? s.key?.machine ?? defaultMachineName(ctx)).slice(0, 80);
  const label = `${client} on ${machine}`.slice(0, 80);

  if (target.kind === 'print' && (!opts.showSecret || opts.dryRun)) {
    out.warn(target.reason);
    out.line(target.render(opts.reuseKey ? s.secret : '<your-api-key>'));
    out.line();
    out.line(
      out.c.dim(
        'Re-run with --show-secret to print this with a dedicated key filled in (the output will contain a secret).',
      ),
    );
    return;
  }

  if (opts.dryRun) {
    await dryRun(ctx, out, target, s, { name, label, reuseKey: opts.reuseKey });
    return;
  }

  const key = await obtainKey(out, s, client, { label, machine, reuseKey: opts.reuseKey });
  let where: string | null = null;
  try {
    where = await apply(ctx, out, target, key.secret, name);
  } catch (err) {
    if (key.minted) await s.api.revokeKey(key.id).catch(() => undefined);
    throw err;
  }

  // Remember the connection; retire the key a previous `connect` created for this client.
  const previous = s.cfg.connections?.[client];
  const connections = {
    ...(s.cfg.connections ?? {}),
    [client]: {
      key_id: key.id,
      key_prefix: key.prefix,
      path: where,
      connected_at: new Date(ctx.now()).toISOString(),
    },
  };
  await saveConfig(ctx, { ...s.cfg, connections });
  const stillUsed = Object.values(connections).some((c) => c.key_id === previous?.key_id);
  if (previous && !stillUsed && previous.key_id !== s.key?.id) {
    await s.api
      .revokeKey(previous.key_id)
      .then(() =>
        out.line(out.c.dim(`Revoked the key ${name} used before (${previous.key_prefix}…).`)),
      )
      .catch(() =>
        out.warn(
          `Could not revoke the old ${name} key ${previous.key_prefix}…; revoke it in the web app.`,
        ),
      );
  }

  out.success(`Connected ${name} to Second Brain.`);
  const rows: [string, string][] = [];
  if (where) rows.push(['Config', tildify(where, ctx.homedir)]);
  rows.push(['Server', `${SERVER_NAME} → ${s.mcpUrl}`]);
  rows.push([
    'Key',
    `${key.prefix}…  ${out.c.dim(key.minted ? label : 'this machine’s login key')}`,
  ]);
  out.fields(rows);
  if (target.kind !== 'print')
    out.line(`Restart ${name} (or reload its MCP servers) to pick up the change.`);
}

async function obtainKey(
  out: Output,
  s: Session,
  client: ClientId,
  opts: { label: string; machine: string; reuseKey: boolean },
): Promise<UsableKey> {
  const loginKey: UsableKey = {
    id: s.key?.id ?? '',
    prefix: s.key?.prefix ?? s.secret.slice(0, 12),
    secret: s.secret,
    minted: false,
  };
  if (opts.reuseKey) return loginKey;
  try {
    const res = await s.api.createKey({
      label: opts.label,
      client,
      machine: opts.machine,
      scopes: s.key?.scopes ?? ['read', 'write'],
      ...(s.key?.project ? { project: s.key.project } : {}),
    });
    out.registerSecret(res.secret, res.key.prefix);
    return { id: res.key.id, prefix: res.key.prefix, secret: res.secret, minted: true };
  } catch (err) {
    if (err instanceof ApiError && (err.status === 403 || err.status === 404)) {
      out.warn(
        `Could not create a dedicated key for ${client} (${err.status}); using this machine's login key instead.`,
      );
      return loginKey;
    }
    throw err;
  }
}

/** Configures the client. Returns the file written, if any. */
async function apply(
  ctx: Ctx,
  out: Output,
  target: Target,
  secret: string,
  name: string,
): Promise<string | null> {
  switch (target.kind) {
    case 'file': {
      if (target.note) out.warn(target.note);
      const plan = await planServerMerge(
        target.path,
        target.container,
        SERVER_NAME,
        target.entry(secret),
      );
      await applyServerMerge(plan);
      describePlan(ctx, out, plan, false);
      return target.path;
    }
    case 'command': {
      const [remove, add] = target.commands(secret);
      await ctx.exec(target.bin, remove!); // fine if there was nothing to remove
      const res = await ctx.exec(target.bin, add!);
      if (res.code !== 0) {
        const detail = (res.stderr || res.stdout).trim().split('\n').slice(-3).join(' ');
        throw new CliError(
          `\`claude mcp add\` failed (exit ${res.code})${detail ? `: ${out.scrub(detail)}` : ''}.`,
        );
      }
      return null;
    }
    case 'print': {
      out.line(`Configure ${name} with:`);
      out.line();
      out.sensitive(target.render(secret));
      out.line();
      out.warn('The output above contains an API key. Do not paste it anywhere public.');
      return null;
    }
  }
}

async function dryRun(
  ctx: Ctx,
  out: Output,
  target: Target,
  s: Session,
  opts: { name: string; label: string; reuseKey: boolean },
): Promise<void> {
  const secret = opts.reuseKey ? s.secret : NEW_KEY_PLACEHOLDER;
  out.line(out.c.bold(`Dry run: nothing will be changed.`));
  out.line(
    opts.reuseKey
      ? `Would use this machine's login key (${s.key?.prefix ?? '?'}…).`
      : `Would create a dedicated API key "${opts.label}" (shown below as ${NEW_KEY_PLACEHOLDER}).`,
  );
  if (target.kind === 'file') {
    if (target.note) out.warn(target.note);
    const plan = await planServerMerge(
      target.path,
      target.container,
      SERVER_NAME,
      target.entry(secret),
    );
    describePlan(ctx, out, plan, true);
    out.line();
    out.line(out.c.dim(`"${plan.container}.${SERVER_NAME}" would be:`));
    out.line(JSON.stringify(target.entry(secret), null, 2));
  } else if (target.kind === 'command') {
    out.line(`Would run:`);
    for (const args of target.commands(secret)) {
      out.line(`  ${[target.bin, ...args].map(shellQuote).join(' ')}`);
    }
  }
}

function describePlan(ctx: Ctx, out: Output, plan: MergePlan, dry: boolean): void {
  const file = tildify(plan.path, ctx.homedir);
  const verb = (would: string, did: string) => (dry ? `would ${would}` : did);
  if (plan.action === 'unchanged') {
    out.line(`${file}: "${SERVER_NAME}" is already up to date.`);
    return;
  }
  out.line(`${file}: ${plan.exists ? verb('update', 'updated') : verb('create', 'created')}`);
  if (plan.createsBackup) {
    out.line(
      `  - ${verb('back up', 'backed up')} the original to ${tildify(plan.backupPath, ctx.homedir)}`,
    );
  }
  out.line(
    `  - ${plan.action === 'add' ? verb('add', 'added') : verb('replace', 'replaced')} server "${SERVER_NAME}"`,
  );
  if (plan.preserved.length > 0) {
    out.line(
      `  - ${verb('keep', 'kept')} ${plan.preserved.length} other server(s): ${plan.preserved.join(', ')}`,
    );
  }
  out.line(`  - file mode ${dry ? 'would be' : 'is'} 0600 (it contains an API key)`);
  if (plan.dropsComments) {
    out.warn(
      `Comments in ${file} ${dry ? 'would not be' : 'were not'} preserved; the backup keeps them.`,
    );
  }
}
