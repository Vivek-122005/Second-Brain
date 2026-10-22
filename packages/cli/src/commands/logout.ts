import { createApi } from '../api';
import { accountFor, loadConfig, resolveApiUrl, saveConfig } from '../config';
import type { Ctx } from '../context';
import type { Output } from '../output';
import { SecretStore } from '../secrets';

export async function logout(ctx: Ctx, out: Output, opts: { api?: string }): Promise<void> {
  const cfg = await loadConfig(ctx);
  const apiUrl = resolveApiUrl(ctx, cfg, opts.api);
  const account = accountFor(apiUrl);
  const store = new SecretStore(ctx);
  const stored = await store.get(account);
  const key = cfg.api_url === apiUrl ? cfg.key : undefined;

  if (!stored && !key) {
    out.line(`Not signed in to ${account}; nothing to do.`);
    return;
  }

  // Revoke first (it needs the secret), but never let a failure keep the secret on disk.
  let revoked = false;
  if (stored && key) {
    out.registerSecret(stored.secret, key.prefix);
    const keptForClients = Object.values(cfg.connections ?? {}).some((c) => c.key_id === key.id);
    if (keptForClients) {
      out.warn(`Key ${key.prefix}… is also used by a connected assistant, so it was not revoked.`);
    } else {
      revoked = await createApi(ctx, apiUrl, stored.secret)
        .revokeKey(key.id)
        .then(() => true)
        .catch((err: Error) => {
          out.warn(`Could not revoke key ${key.prefix}… on the server (${err.message}).`);
          return false;
        });
    }
  }

  await store.delete(account);
  if (cfg.api_url === apiUrl) {
    const { key: _key, ...rest } = cfg;
    await saveConfig(ctx, rest);
  }

  out.success(
    `Signed out of ${account}.${key ? ` Key ${key.prefix}… ${revoked ? 'was revoked' : 'was removed from this machine'}.` : ''}`,
  );
  const connected = Object.keys(cfg.connections ?? {});
  if (connected.length > 0 && cfg.api_url === apiUrl) {
    out.line(
      out.c.dim(
        `Assistants you connected (${connected.join(', ')}) keep their own keys; manage them with \`brain keys\` or in the web app.`,
      ),
    );
  }
}
