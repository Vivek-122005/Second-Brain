import { createApi, type ApiClient } from './api';
import {
  accountFor,
  assertSecureTransport,
  defaultMcpUrl,
  loadConfig,
  resolveApiUrl,
  type CliConfig,
  type StoredKey,
} from './config';
import type { Ctx } from './context';
import { CliError, ExitCode } from './errors';
import type { Output } from './output';
import { SecretStore, type SecretBackend } from './secrets';

export interface Session {
  cfg: CliConfig;
  apiUrl: string;
  mcpUrl: string;
  account: string;
  secret: string;
  backend: SecretBackend;
  /** Key metadata saved at login; undefined if the config belongs to a different API URL. */
  key: StoredKey | undefined;
  api: ApiClient;
  store: SecretStore;
}

/** Loads config and the stored secret, or fails with "not signed in" (exit code 3). */
export async function requireSession(ctx: Ctx, out: Output, apiFlag?: string): Promise<Session> {
  const cfg = await loadConfig(ctx);
  const apiUrl = resolveApiUrl(ctx, cfg, apiFlag);
  const account = accountFor(apiUrl);
  const store = new SecretStore(ctx);
  const stored = await store.get(account);
  if (!stored) {
    throw new CliError(
      `Not signed in to ${account}.`,
      ExitCode.Auth,
      `Run \`brain login${apiFlag ? ` --api ${apiUrl}` : ''}\` first.`,
    );
  }
  assertSecureTransport(ctx, apiUrl);
  const sameApi = cfg.api_url === apiUrl;
  const key = sameApi ? cfg.key : undefined;
  out.registerSecret(stored.secret, key?.prefix);
  return {
    cfg,
    apiUrl,
    mcpUrl: (sameApi && cfg.mcp_url) || defaultMcpUrl(apiUrl),
    account,
    secret: stored.secret,
    backend: stored.backend,
    key,
    api: createApi(ctx, apiUrl, stored.secret),
    store,
  };
}
