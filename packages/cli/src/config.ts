import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { KeyScope } from '@second-brain/schema';
import type { Ctx } from './context';
import { CliError, ExitCode, UsageError } from './errors';

export const DEFAULT_API_URL = 'http://localhost:8787';

/** `~/.second-brain`, or `$SECOND_BRAIN_HOME`. */
export function brainHome(ctx: Ctx): string {
  const override = ctx.env.SECOND_BRAIN_HOME;
  return override ? path.resolve(override) : path.join(ctx.homedir, '.second-brain');
}

/** Non-secret facts about the key this machine signed in with. */
export interface StoredKey {
  id: string;
  prefix: string;
  label: string;
  scopes: KeyScope[];
  client: string | null;
  machine: string | null;
  project: string | null;
}

export interface Connection {
  /** Key written into the assistant's config; equals the login key id when it was reused. */
  key_id: string;
  key_prefix: string;
  /** Config file we wrote, or `null` when configured by command (Claude Code). */
  path: string | null;
  connected_at: string;
}

/** `~/.second-brain/config.json`. Never contains secrets. */
export interface CliConfig {
  api_url?: string;
  mcp_url?: string;
  key?: StoredKey;
  connections?: Record<string, Connection>;
}

export function configPath(ctx: Ctx): string {
  return path.join(brainHome(ctx), 'config.json');
}

export async function readJsonFile<T>(file: string): Promise<T | undefined> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new CliError(`${file} is not valid JSON.`, ExitCode.Error, 'Fix or delete the file.');
  }
}

/** Writes JSON atomically (temp file + rename) with the given mode. */
export async function writeJsonFile(file: string, value: unknown, mode = 0o600): Promise<void> {
  await writeTextFile(file, JSON.stringify(value, null, 2) + '\n', mode);
}

export async function writeTextFile(file: string, text: string, mode = 0o600): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, text, { mode });
  await chmod(tmp, mode);
  await rename(tmp, file);
}

export async function ensureBrainHome(ctx: Ctx): Promise<string> {
  const dir = brainHome(ctx);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export async function loadConfig(ctx: Ctx): Promise<CliConfig> {
  const cfg = await readJsonFile<CliConfig>(configPath(ctx));
  return cfg && typeof cfg === 'object' ? cfg : {};
}

export async function saveConfig(ctx: Ctx, cfg: CliConfig): Promise<void> {
  await ensureBrainHome(ctx);
  await writeJsonFile(configPath(ctx), cfg, 0o600);
}

/**
 * Accepts `https://brain.example.com`, `https://brain.example.com/` or `…/api/v1` and returns the
 * base URL without a trailing slash or API prefix.
 */
export function normalizeApiUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new UsageError(
      `"${input}" is not a valid URL.`,
      'Example: --api https://brain.example.com',
    );
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UsageError(`The API URL must use http or https (got ${url.protocol}).`);
  }
  url.search = '';
  url.hash = '';
  const p = url.pathname.replace(/\/+$/, '').replace(/\/api\/v1$/, '');
  return url.origin + p;
}

export function isLocalHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.localhost');
}

/** Refuses to send a bearer key over plain HTTP to anything but this machine. */
export function assertSecureTransport(ctx: Ctx, apiUrl: string): void {
  const url = new URL(apiUrl);
  if (url.protocol === 'https:' || isLocalHost(url.hostname)) return;
  if (ctx.env.SECOND_BRAIN_ALLOW_HTTP === '1') return;
  throw new UsageError(
    `Refusing to use ${url.origin} over plain HTTP: API keys would travel unencrypted.`,
    'Use an https:// URL, or set SECOND_BRAIN_ALLOW_HTTP=1 for a trusted private network.',
  );
}

/** `--api`, then `SECOND_BRAIN_API_URL`, then saved config, then the local dev server. */
export function resolveApiUrl(ctx: Ctx, cfg: CliConfig, flag?: string): string {
  const raw = flag ?? ctx.env.SECOND_BRAIN_API_URL ?? cfg.api_url ?? DEFAULT_API_URL;
  return normalizeApiUrl(raw);
}

/** Keychain account for an API: its origin, so one machine can hold keys for several servers. */
export function accountFor(apiUrl: string): string {
  return new URL(apiUrl).origin;
}

export function defaultMcpUrl(apiUrl: string): string {
  return `${apiUrl}/mcp`;
}

/** Default machine name: the hostname without macOS's `.local` suffix. */
export function defaultMachineName(ctx: Ctx): string {
  const name = ctx.hostname.replace(/\.local$/i, '').trim() || 'unknown-machine';
  return name.slice(0, 80);
}
