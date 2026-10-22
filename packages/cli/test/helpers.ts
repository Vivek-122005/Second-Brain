import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ApiKey } from '@second-brain/schema';
import { vi } from 'vitest';
import type { Ctx, ExecResult } from '../src/context';
import { run } from '../src/main';
import type { KeyringModule } from '../src/secrets';

export const API = 'https://brain.example.com';
export const SECRET = 'sb_live_ab12CDefGhijKLmnOPqrSTuvWXyz0123456789';
export const PREFIX = 'sb_live_ab12';

export function apiKey(over: Partial<ApiKey> = {}): ApiKey {
  return {
    id: 'key_login',
    label: 'cli on test-mac',
    machine: 'test-mac',
    client: 'cli',
    prefix: PREFIX,
    scopes: ['read', 'write'],
    space_id: null,
    project: null,
    created_at: '2026-10-01T00:00:00.000Z',
    last_used_at: null,
    expires_at: null,
    revoked_at: null,
    ...over,
  };
}

export interface Reply {
  status?: number;
  body?: unknown;
}
export type Handler = (req: {
  method: string;
  path: string;
  body: unknown;
  auth: string | null;
}) => Reply | Promise<Reply> | 'network-error';

export interface Call {
  method: string;
  path: string;
  body: unknown;
  auth: string | null;
}

/** A fetch mock that routes `METHOD /path` (path relative to `/api/v1`, query included). */
export function mockFetch(routes: Record<string, Handler | Reply>) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const p = url.pathname.replace(/^\/api\/v1/, '') + url.search;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    const call = { method, path: p, body, auth: headers.authorization ?? null };
    calls.push(call);
    const route =
      routes[`${method} ${p}`] ?? routes[`${method} ${url.pathname.replace(/^\/api\/v1/, '')}`];
    if (!route)
      return new Response(JSON.stringify({ title: 'Not Found', status: 404 }), { status: 404 });
    const reply = typeof route === 'function' ? await route(call) : route;
    if (reply === 'network-error')
      throw new TypeError('fetch failed', { cause: new Error('ECONNREFUSED') });
    const status = reply.status ?? 200;
    return new Response(
      status === 204 || reply.body === undefined ? null : JSON.stringify(reply.body),
      {
        status,
        headers: { 'content-type': 'application/json' },
      },
    );
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

/** In-memory stand-in for `@napi-rs/keyring`. */
export function fakeKeyring(opts: { failOn?: 'construct' | 'set' | 'all' } = {}) {
  const store = new Map<string, string>();
  const mod: KeyringModule = {
    Entry: class {
      private readonly id: string;
      constructor(service: string, account: string) {
        if (opts.failOn === 'construct')
          throw new Error('Platform secure storage failure: no D-Bus');
        this.id = `${service}|${account}`;
      }
      getPassword() {
        if (opts.failOn === 'all') throw new Error('keychain locked');
        return store.get(this.id) ?? null;
      }
      setPassword(p: string) {
        if (opts.failOn === 'set' || opts.failOn === 'all') throw new Error('No secret service');
        store.set(this.id, p);
      }
      deletePassword() {
        return store.delete(this.id);
      }
    },
  };
  return { mod, store };
}

export interface TestEnv {
  ctx: Ctx;
  home: string;
  brainHome: string;
  stdout: () => string;
  stderr: () => string;
  output: () => string;
  execCalls: { file: string; args: string[] }[];
  opened: string[];
  keyring: ReturnType<typeof fakeKeyring>;
  run(...argv: string[]): Promise<number>;
  cleanup(): Promise<void>;
}

export async function makeEnv(
  over: Partial<Ctx> & {
    keyring?: ReturnType<typeof fakeKeyring> | null;
    execResult?: ExecResult;
  } = {},
): Promise<TestEnv> {
  const home = await mkdtemp(path.join(os.tmpdir(), 'brain-cli-test-'));
  const brainHome = path.join(home, '.second-brain');
  let out = '';
  let err = '';
  let clock = Date.parse('2026-10-21T12:00:00.000Z');
  const execCalls: { file: string; args: string[] }[] = [];
  const opened: string[] = [];
  const keyring = over.keyring === undefined ? fakeKeyring() : over.keyring;
  const ctx: Ctx = {
    env: { SECOND_BRAIN_HOME: brainHome, NO_COLOR: '1' },
    homedir: home,
    platform: 'darwin',
    hostname: 'test-mac.local',
    stdout: { write: (s: string) => (out += s) },
    stderr: { write: (s: string) => (err += s) },
    fetch: mockFetch({}).fetch,
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    openUrl: async (url) => {
      opened.push(url);
      return true;
    },
    which: () => null,
    exec: async (file, args) => {
      execCalls.push({ file, args });
      return over.execResult ?? { code: 0, stdout: '', stderr: '' };
    },
    loadKeyring: async () => keyring?.mod ?? null,
    ...over,
  };
  return {
    ctx,
    home,
    brainHome,
    stdout: () => out,
    stderr: () => err,
    output: () => out + err,
    execCalls,
    opened,
    keyring: keyring ?? fakeKeyring(),
    run: (...argv) => run(argv, ctx),
    cleanup: () => rm(home, { recursive: true, force: true }),
  };
}

/** Puts the env into a signed-in state without going through the device flow. */
export async function signIn(env: TestEnv, opts: { scopes?: ('read' | 'write')[] } = {}) {
  const { saveConfig } = await import('../src/config');
  const { SecretStore } = await import('../src/secrets');
  await new SecretStore(env.ctx).set(API, SECRET);
  await saveConfig(env.ctx, {
    api_url: API,
    mcp_url: `${API}/mcp`,
    key: {
      id: 'key_login',
      prefix: PREFIX,
      label: 'cli on test-mac',
      scopes: opts.scopes ?? ['read', 'write'],
      client: 'cli',
      machine: 'test-mac',
      project: null,
    },
  });
}
