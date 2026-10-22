import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ExitCode } from '../src/errors';
import {
  API,
  apiKey,
  fakeKeyring,
  makeEnv,
  mockFetch,
  PREFIX,
  SECRET,
  signIn,
  type TestEnv,
} from './helpers';

const deviceRoutes = (overrides: Record<string, unknown> = {}) => {
  let polls = 0;
  return mockFetch({
    'POST /auth/device': {
      body: {
        device_code: 'dev_123',
        user_code: 'WDJB-MJHT',
        verification_uri: `${API}/device`,
        verification_uri_complete: `${API}/device?code=WDJB-MJHT`,
        interval: 5,
        expires_in: 600,
      },
    },
    'POST /auth/device/token': () =>
      ++polls < 2
        ? { status: 428, body: { error: 'authorization_pending' } }
        : {
            body: {
              key: apiKey(),
              secret: SECRET,
              api_url: API,
              mcp_url: `${API}/mcp`,
            },
          },
    'DELETE /keys/key_old': { status: 204 },
    ...overrides,
  });
};

let env: TestEnv;
afterEach(async () => {
  await env?.cleanup();
});

describe('brain login', () => {
  it('runs the device flow, stores the secret in the keychain and saves non-secret config', async () => {
    const { fetch, calls } = deviceRoutes();
    env = await makeEnv({ fetch });
    const code = await env.run('login', '--api', `${API}/`, '--machine', 'ci-box');

    expect(code).toBe(ExitCode.Ok);
    expect(calls[0]).toMatchObject({
      method: 'POST',
      path: '/auth/device',
      body: { client: 'cli', machine: 'ci-box' },
      auth: null,
    });
    expect(env.stdout()).toContain('WDJB-MJHT');
    expect(env.stdout()).toContain(`${API}/device`);
    expect(env.opened).toEqual([`${API}/device?code=WDJB-MJHT`]);
    expect(env.keyring.store.get(`second-brain|${API}`)).toBe(SECRET);

    const cfg = JSON.parse(await readFile(path.join(env.brainHome, 'config.json'), 'utf8'));
    expect(cfg).toMatchObject({
      api_url: API,
      mcp_url: `${API}/mcp`,
      key: { id: 'key_login', prefix: PREFIX },
    });
    expect(JSON.stringify(cfg)).not.toContain(SECRET);
    expect(env.output()).not.toContain(SECRET);
    expect(env.stdout()).toContain(`${PREFIX}…`);
    await expect(stat(path.join(env.brainHome, 'credentials.json'))).rejects.toThrow();
  });

  it('defaults the machine to the hostname without .local and honours --no-browser', async () => {
    const { fetch, calls } = deviceRoutes();
    env = await makeEnv({ fetch });
    await env.run('login', '--api', API, '--no-browser', '--client', 'my-cli');
    expect(calls[0]!.body).toEqual({ client: 'my-cli', machine: 'test-mac' });
    expect(env.opened).toEqual([]);
  });

  it('uses SECOND_BRAIN_API_URL before saved config, and saved config before the default', async () => {
    const { fetch, calls } = deviceRoutes();
    env = await makeEnv({ fetch });
    env.ctx.env.SECOND_BRAIN_API_URL = API;
    await env.run('login', '--no-browser');
    expect(calls[0]!.path).toBe('/auth/device');
    expect(env.keyring.store.has(`second-brain|${API}`)).toBe(true);
  });

  it('falls back to a 0600 credentials file with a warning when the keychain is unavailable', async () => {
    const { fetch } = deviceRoutes();
    env = await makeEnv({ fetch, keyring: fakeKeyring({ failOn: 'set' }) });
    expect(await env.run('login', '--api', API, '--no-browser')).toBe(0);

    const file = path.join(env.brainHome, 'credentials.json');
    const creds = JSON.parse(await readFile(file, 'utf8'));
    expect(creds.secrets[API]).toBe(SECRET);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(env.stderr()).toMatch(/keychain unavailable/i);
    expect(env.stderr().trim().split('\n')).toHaveLength(1);
    expect(env.output()).not.toContain(SECRET);
  });

  it('falls back to the file when the native keyring module is missing', async () => {
    const { fetch } = deviceRoutes();
    env = await makeEnv({ fetch, keyring: null });
    expect(await env.run('login', '--api', API, '--no-browser')).toBe(0);
    expect(env.stderr()).toMatch(/not available for this platform/);
    const status = await env.run('status');
    expect(status).toBe(ExitCode.Error); // GET /me is not routed in this mock → 404
    expect(env.stdout()).toMatch(/credentials\.json \(mode 0600\)/);
  });

  it('exits with LoginFailed when the user denies access', async () => {
    const { fetch } = deviceRoutes({
      'POST /auth/device/token': { status: 403, body: { error: 'access_denied' } },
    });
    env = await makeEnv({ fetch });
    expect(await env.run('login', '--api', API, '--no-browser')).toBe(ExitCode.LoginFailed);
    expect(env.stderr()).toMatch(/denied/);
    expect(env.keyring.store.size).toBe(0);
  });

  it('refuses plain HTTP to a remote host', async () => {
    env = await makeEnv();
    expect(await env.run('login', '--api', 'http://brain.example.com')).toBe(ExitCode.Usage);
    expect(env.stderr()).toMatch(/plain HTTP/);
  });

  it('reports an unreachable server with the network exit code', async () => {
    const { fetch } = mockFetch({ 'POST /auth/device': () => 'network-error' });
    env = await makeEnv({ fetch });
    expect(await env.run('login', '--api', API, '--no-browser')).toBe(ExitCode.Network);
    expect(env.stderr()).toMatch(/Could not reach https:\/\/brain\.example\.com/);
  });

  it('revokes the previous login key when signing in again', async () => {
    const { fetch, calls } = deviceRoutes();
    env = await makeEnv({ fetch });
    await signIn(env);
    const { saveConfig, loadConfig } = await import('../src/config');
    const cfg = await loadConfig(env.ctx);
    await saveConfig(env.ctx, { ...cfg, key: { ...cfg.key!, id: 'key_old' } });

    expect(await env.run('login', '--no-browser')).toBe(0);
    expect(calls.some((c) => c.method === 'DELETE' && c.path === '/keys/key_old')).toBe(true);
  });
});

describe('brain status', () => {
  it('shows the API, user, key prefix and scopes without the secret', async () => {
    const { fetch, calls } = mockFetch({
      'GET /me': {
        body: {
          user: { id: 'usr_1', email: 'ada@example.com', name: 'Ada' },
          spaces: [
            {
              id: 'spc_1',
              name: 'Personal',
              kind: 'personal',
              role: 'owner',
              vault: { provider: 'memory', repo: null },
            },
          ],
          default_space_id: 'spc_1',
        },
      },
    });
    env = await makeEnv({ fetch });
    await signIn(env);
    expect(await env.run('status')).toBe(0);
    const out = env.stdout();
    expect(out).toContain(API);
    expect(out).toContain('Ada <ada@example.com>');
    expect(out).toContain(`${PREFIX}…`);
    expect(out).toContain('read, write');
    expect(out).toContain('macOS Keychain');
    expect(env.output()).not.toContain(SECRET);
    expect(calls[0]!.auth).toBe(`Bearer ${SECRET}`);
  });

  it('exits 3 when not signed in', async () => {
    env = await makeEnv();
    expect(await env.run('status')).toBe(ExitCode.Auth);
    expect(env.stdout()).toMatch(/Signed in\s+no/);
  });

  it('exits 3 when the server rejects the key', async () => {
    const { fetch } = mockFetch({
      'GET /me': { status: 401, body: { title: 'Unauthorized', status: 401 } },
    });
    env = await makeEnv({ fetch });
    await signIn(env);
    expect(await env.run('status')).toBe(ExitCode.Auth);
    expect(env.stdout()).toMatch(/key rejected/);
    expect(env.output()).not.toContain(SECRET);
  });
});

describe('brain logout', () => {
  it('revokes the key on the server and deletes the stored secret', async () => {
    const { fetch, calls } = mockFetch({ 'DELETE /keys/key_login': { status: 204 } });
    env = await makeEnv({ fetch });
    await signIn(env);
    expect(await env.run('logout')).toBe(0);
    expect(calls).toEqual([
      expect.objectContaining({
        method: 'DELETE',
        path: '/keys/key_login',
        auth: `Bearer ${SECRET}`,
      }),
    ]);
    expect(env.keyring.store.size).toBe(0);
    const cfg = JSON.parse(await readFile(path.join(env.brainHome, 'config.json'), 'utf8'));
    expect(cfg.key).toBeUndefined();
    expect(cfg.api_url).toBe(API);
    expect(env.stdout()).toMatch(/was revoked/);
  });

  it('still deletes the local secret when the server cannot be reached', async () => {
    const { fetch } = mockFetch({ 'DELETE /keys/key_login': () => 'network-error' });
    env = await makeEnv({ fetch });
    await signIn(env);
    expect(await env.run('logout')).toBe(0);
    expect(env.keyring.store.size).toBe(0);
    expect(env.stderr()).toMatch(/Could not revoke/);
  });

  it('removes a secret stored in the fallback file', async () => {
    env = await makeEnv({ keyring: fakeKeyring({ failOn: 'all' }) });
    await signIn(env);
    const file = path.join(env.brainHome, 'credentials.json');
    expect((await stat(file)).isFile()).toBe(true);
    env.ctx.fetch = mockFetch({ 'DELETE /keys/key_login': { status: 204 } }).fetch;
    expect(await env.run('logout')).toBe(0);
    await expect(stat(file)).rejects.toThrow();
  });
});

describe('brain keys', () => {
  it('lists keys in a table and follows pagination', async () => {
    const { fetch } = mockFetch({
      'GET /keys': {
        body: {
          items: [
            apiKey({ last_used_at: '2026-10-21T11:55:00.000Z' }),
            apiKey({
              id: 'key_2',
              prefix: 'sb_live_zz99',
              label: 'cursor on test-mac',
              client: 'cursor',
              revoked_at: '2026-10-10T00:00:00.000Z',
            }),
          ],
          next_cursor: 'c2',
        },
      },
      'GET /keys?cursor=c2': {
        body: {
          items: [
            apiKey({
              id: 'key_3',
              prefix: 'sb_live_yy88',
              label: 'vscode on laptop',
              client: 'vscode',
              machine: 'laptop',
            }),
          ],
          next_cursor: null,
        },
      },
    });
    env = await makeEnv({ fetch });
    await signIn(env);
    expect(await env.run('keys')).toBe(0);
    const lines = env.stdout().trim().split('\n');
    expect(lines[0]).toMatch(/^PREFIX\s+LABEL\s+CLIENT\s+MACHINE\s+LAST USED\s+STATUS$/);
    expect(lines[1]).toMatch(/sb_live_ab12… \*.*cli on test-mac.*cli.*test-mac.*5 min ago.*active/);
    expect(lines[2]).toMatch(/sb_live_yy88….*vscode.*laptop.*never.*active/);
    expect(lines[3]).toMatch(/sb_live_zz99….*revoked/);
    expect(env.output()).not.toContain(SECRET);
  });
});
