import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ExitCode } from '../src/errors';
import {
  API,
  apiKey,
  makeEnv,
  mockFetch,
  SECRET,
  signIn,
  type Call,
  type TestEnv,
} from './helpers';

const MCP = `${API}/mcp`;
const NEW_SECRET = 'sb_live_cu55NewSecretForCursorXYZ0123456789ab';

function keyServer(extra: Record<string, unknown> = {}) {
  let n = 0;
  return mockFetch({
    'POST /keys': ({ body }) => {
      n++;
      const b = body as { label: string; client: string; machine: string };
      return {
        status: 201,
        body: {
          key: apiKey({
            id: `key_new${n}`,
            prefix: `sb_live_cu5${n}`,
            label: b.label,
            client: b.client,
            machine: b.machine,
          }),
          secret: n === 1 ? NEW_SECRET : `${NEW_SECRET}${n}`,
        },
      };
    },
    'DELETE /keys/key_new1': { status: 204 },
    ...extra,
  });
}

const cursorFile = (env: TestEnv) => path.join(env.home, '.cursor', 'mcp.json');
const desktopFile = (env: TestEnv) =>
  path.join(env.home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
const readJson = async (file: string) => JSON.parse(await readFile(file, 'utf8'));
const mode = async (file: string) => (await stat(file)).mode & 0o777;

let env: TestEnv;
let calls: Call[];
afterEach(async () => {
  await env?.cleanup();
});

async function setup(extra: Record<string, unknown> = {}) {
  const server = keyServer(extra);
  calls = server.calls;
  env = await makeEnv({ fetch: server.fetch });
  await signIn(env);
}

describe('brain connect cursor', () => {
  it('mints a dedicated key and merges it into ~/.cursor/mcp.json, keeping other servers', async () => {
    await setup();
    const file = cursorFile(env);
    await mkdir(path.dirname(file), { recursive: true });
    const original = JSON.stringify({ mcpServers: { github: { command: 'gh-mcp' } }, other: true });
    await writeFile(file, original, { mode: 0o644 });

    expect(await env.run('connect', 'cursor')).toBe(0);

    expect(calls[0]).toMatchObject({
      method: 'POST',
      path: '/keys',
      auth: `Bearer ${SECRET}`,
      body: {
        label: 'cursor on test-mac',
        client: 'cursor',
        machine: 'test-mac',
        scopes: ['read', 'write'],
      },
    });
    const cfg = await readJson(file);
    expect(cfg.other).toBe(true);
    expect(cfg.mcpServers.github).toEqual({ command: 'gh-mcp' });
    expect(cfg.mcpServers['second-brain']).toEqual({
      url: MCP,
      headers: { Authorization: `Bearer ${NEW_SECRET}` },
    });
    expect(await mode(file)).toBe(0o600);
    expect(await readFile(`${file}.bak`, 'utf8')).toBe(original);
    expect(await mode(`${file}.bak`)).toBe(0o600);

    expect(env.output()).not.toContain(NEW_SECRET);
    expect(env.output()).not.toContain(SECRET);
    expect(env.stdout()).toContain('sb_live_cu51…');
    expect(env.stdout()).toMatch(/kept 1 other server\(s\): github/);

    const saved = await readJson(path.join(env.brainHome, 'config.json'));
    expect(saved.connections.cursor).toMatchObject({
      key_id: 'key_new1',
      key_prefix: 'sb_live_cu51',
      path: file,
    });
  });

  it('keeps the first .bak on reconnect and revokes the key it replaces', async () => {
    await setup();
    const file = cursorFile(env);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '{"mcpServers":{}}');

    await env.run('connect', 'cursor');
    await env.run('connect', 'cursor');

    expect(await readFile(`${file}.bak`, 'utf8')).toBe('{"mcpServers":{}}');
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(2);
    expect(calls.some((c) => c.method === 'DELETE' && c.path === '/keys/key_new1')).toBe(true);
    const cfg = await readJson(file);
    expect(cfg.mcpServers['second-brain'].headers.Authorization).toBe(`Bearer ${NEW_SECRET}2`);
    expect(env.output()).not.toContain(NEW_SECRET);
  });

  it('creates the file (no backup needed) when it does not exist', async () => {
    await setup();
    expect(await env.run('connect', 'cursor')).toBe(0);
    expect(await readJson(cursorFile(env))).toEqual({
      mcpServers: {
        'second-brain': { url: MCP, headers: { Authorization: `Bearer ${NEW_SECRET}` } },
      },
    });
    await expect(stat(`${cursorFile(env)}.bak`)).rejects.toThrow();
  });

  it('--dry-run writes nothing, creates no key and prints no secret', async () => {
    await setup();
    const file = cursorFile(env);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '{"mcpServers":{"github":{"command":"gh"}}}');

    expect(await env.run('connect', 'cursor', '--dry-run')).toBe(0);

    expect(calls).toHaveLength(0);
    expect(await readFile(file, 'utf8')).toBe('{"mcpServers":{"github":{"command":"gh"}}}');
    await expect(stat(`${file}.bak`)).rejects.toThrow();
    const out = env.stdout();
    expect(out).toMatch(/Dry run/);
    expect(out).toMatch(/would update/);
    expect(out).toMatch(/would back up the original/);
    expect(out).toMatch(/would add server "second-brain"/);
    expect(out).toMatch(/would keep 1 other server\(s\): github/);
    expect(out).toContain('Bearer <new-api-key>');
    expect(env.output()).not.toContain(SECRET);
  });

  it('--dry-run --reuse-key masks the login key', async () => {
    await setup();
    expect(await env.run('connect', 'cursor', '--dry-run', '--reuse-key')).toBe(0);
    expect(env.stdout()).toContain('Bearer sb_live_ab12…');
    expect(env.output()).not.toContain(SECRET);
  });

  it('--reuse-key writes the login key without minting', async () => {
    await setup();
    expect(await env.run('connect', 'cursor', '--reuse-key')).toBe(0);
    expect(calls).toHaveLength(0);
    expect((await readJson(cursorFile(env))).mcpServers['second-brain'].headers.Authorization).toBe(
      `Bearer ${SECRET}`,
    );
    expect(env.output()).not.toContain(SECRET);
  });

  it('falls back to the login key when the server will not mint keys for API-key callers', async () => {
    await setup({ 'POST /keys': { status: 403, body: { title: 'Forbidden', status: 403 } } });
    expect(await env.run('connect', 'cursor')).toBe(0);
    expect(env.stderr()).toMatch(/using this machine's login key/);
    expect((await readJson(cursorFile(env))).mcpServers['second-brain'].headers.Authorization).toBe(
      `Bearer ${SECRET}`,
    );
  });

  it('refuses to touch a config file it cannot parse, and revokes the minted key', async () => {
    await setup();
    const file = cursorFile(env);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '{ "mcpServers": { oops ');
    expect(await env.run('connect', 'cursor')).toBe(ExitCode.Error);
    expect(await readFile(file, 'utf8')).toBe('{ "mcpServers": { oops ');
    expect(env.stderr()).toMatch(/Could not parse/);
    expect(calls.some((c) => c.method === 'DELETE' && c.path === '/keys/key_new1')).toBe(true);
  });

  it('requires a login', async () => {
    env = await makeEnv();
    expect(await env.run('connect', 'cursor')).toBe(ExitCode.Auth);
    expect(env.stderr()).toMatch(/Not signed in/);
  });
});

describe('brain connect vscode', () => {
  it('merges into the user mcp.json under "servers", tolerating JSONC', async () => {
    await setup();
    env.ctx.platform = 'linux';
    env.ctx.env.XDG_CONFIG_HOME = path.join(env.home, 'xdg');
    const file = path.join(env.home, 'xdg', 'Code', 'User', 'mcp.json');
    await mkdir(path.dirname(file), { recursive: true });
    const original = `{
  // my servers
  "servers": {
    "memory": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-memory"], }, /* trailing */
  },
  "inputs": [],
}`;
    await writeFile(file, original);

    expect(await env.run('connect', 'vscode')).toBe(0);
    const cfg = await readJson(file);
    expect(Object.keys(cfg.servers)).toEqual(['memory', 'second-brain']);
    expect(cfg.servers.memory.args).toEqual(['-y', '@modelcontextprotocol/server-memory']);
    expect(cfg.servers['second-brain']).toEqual({
      type: 'http',
      url: MCP,
      headers: { Authorization: `Bearer ${NEW_SECRET}` },
    });
    expect(cfg.inputs).toEqual([]);
    expect(await readFile(`${file}.bak`, 'utf8')).toBe(original);
    expect(env.stderr()).toMatch(/Comments .* were not preserved/);
  });

  it('prints a masked snippet (and mints nothing) when VS Code is not installed', async () => {
    await setup();
    env.ctx.platform = 'linux';
    expect(await env.run('connect', 'vscode')).toBe(0);
    expect(calls).toHaveLength(0);
    expect(env.stdout()).toContain('"servers"');
    expect(env.stdout()).toContain('Bearer <your-api-key>');
    expect(env.stdout()).toMatch(/--show-secret/);
  });

  it('--show-secret prints the snippet with a freshly minted key', async () => {
    await setup();
    env.ctx.platform = 'linux';
    expect(await env.run('connect', 'vscode', '--show-secret')).toBe(0);
    expect(env.stdout()).toContain(`Bearer ${NEW_SECRET}`);
    expect(env.stdout()).not.toContain(SECRET);
    expect(env.stderr()).toMatch(/contains an API key/);
  });

  it('--config targets an explicit file', async () => {
    await setup();
    const file = path.join(env.home, 'custom', 'insiders-mcp.json');
    expect(await env.run('connect', 'vscode', '--config', file)).toBe(0);
    expect((await readJson(file)).servers['second-brain'].type).toBe('http');
  });
});

describe('brain connect claude-desktop', () => {
  it('bridges with mcp-remote and passes the key through env', async () => {
    await setup();
    const file = desktopFile(env);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      JSON.stringify({ mcpServers: { fs: { command: 'npx', args: ['fs'] } }, theme: 'dark' }),
    );

    expect(await env.run('connect', 'claude-desktop')).toBe(0);
    const cfg = await readJson(file);
    expect(cfg.theme).toBe('dark');
    expect(cfg.mcpServers.fs).toEqual({ command: 'npx', args: ['fs'] });
    expect(cfg.mcpServers['second-brain']).toEqual({
      command: 'npx',
      args: ['-y', 'mcp-remote', MCP, '--header', 'Authorization:${SECOND_BRAIN_AUTH}'],
      env: { SECOND_BRAIN_AUTH: `Bearer ${NEW_SECRET}` },
    });
    expect(JSON.stringify(cfg.mcpServers['second-brain'].args)).not.toContain(NEW_SECRET);
    expect(await mode(file)).toBe(0o600);
    expect(await stat(`${file}.bak`)).toBeTruthy();
    expect(env.output()).not.toContain(NEW_SECRET);
  });

  it('uses %APPDATA% on Windows', async () => {
    await setup();
    env.ctx.platform = 'win32';
    env.ctx.env.APPDATA = path.join(env.home, 'AppData');
    expect(await env.run('connect', 'claude-desktop')).toBe(0);
    const file = path.join(env.home, 'AppData', 'Claude', 'claude_desktop_config.json');
    expect((await readJson(file)).mcpServers['second-brain'].command).toBe('npx');
  });
});

describe('brain connect claude-code', () => {
  it('runs `claude mcp add` with the official flags when claude is installed', async () => {
    await setup();
    env.ctx.which = (cmd) => (cmd === 'claude' ? '/usr/local/bin/claude' : null);
    expect(await env.run('connect', 'claude-code')).toBe(0);
    expect(env.execCalls).toEqual([
      { file: '/usr/local/bin/claude', args: ['mcp', 'remove', '--scope', 'user', 'second-brain'] },
      {
        file: '/usr/local/bin/claude',
        args: [
          'mcp',
          'add',
          '--transport',
          'http',
          '--scope',
          'user',
          'second-brain',
          MCP,
          '--header',
          `Authorization: Bearer ${NEW_SECRET}`,
        ],
      },
    ]);
    expect(env.output()).not.toContain(NEW_SECRET);
    const saved = await readJson(path.join(env.brainHome, 'config.json'));
    expect(saved.connections['claude-code']).toMatchObject({ key_id: 'key_new1', path: null });
  });

  it('reports a failing `claude mcp add` and revokes the minted key', async () => {
    const server = keyServer();
    calls = server.calls;
    env = await makeEnv({
      fetch: server.fetch,
      execResult: { code: 1, stdout: '', stderr: `boom Bearer ${NEW_SECRET}` },
    });
    await signIn(env);
    env.ctx.which = () => '/usr/local/bin/claude';
    expect(await env.run('connect', 'claude-code')).toBe(ExitCode.Error);
    expect(env.stderr()).toMatch(/claude mcp add.*failed/);
    expect(env.output()).not.toContain(NEW_SECRET);
    expect(calls.some((c) => c.method === 'DELETE' && c.path === '/keys/key_new1')).toBe(true);
  });

  it('prints the command with the key masked when claude is not on PATH', async () => {
    await setup();
    expect(await env.run('connect', 'claude-code')).toBe(0);
    expect(env.execCalls).toEqual([]);
    expect(calls).toHaveLength(0);
    expect(env.stderr()).toMatch(/not found on your PATH/);
    expect(env.stdout()).toContain(
      `claude mcp add --transport http --scope user second-brain ${MCP} --header 'Authorization: Bearer <your-api-key>'`,
    );
  });

  it('--dry-run shows the commands with the key masked', async () => {
    await setup();
    env.ctx.which = () => '/usr/local/bin/claude';
    expect(await env.run('connect', 'claude-code', '--dry-run', '--reuse-key')).toBe(0);
    expect(env.execCalls).toEqual([]);
    expect(env.stdout()).toContain("--header 'Authorization: Bearer sb_live_ab12…'");
    expect(env.output()).not.toContain(SECRET);
  });
});

describe('brain connect argument handling', () => {
  it('rejects unknown clients with exit code 2', async () => {
    await setup();
    expect(await env.run('connect', 'emacs')).toBe(ExitCode.Usage);
    expect(env.stderr()).toMatch(/Supported: claude-code, cursor, claude-desktop, vscode/);
  });
});
