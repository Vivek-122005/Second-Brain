import type {
  DashboardResponse,
  DeviceStartResponse,
  MeResponse,
  NoteDetail,
} from '@second-brain/schema';
import { describe, expect, it } from 'vitest';
import { call, mcp, newUserWithKey } from './helpers';

const ORIGIN = 'http://app.test';

async function signIn(email: string): Promise<string> {
  const res = await call('/api/v1/auth/magic-link', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ email }),
  });
  expect(res.status).toBe(202);
  const body = (await res.json()) as { dev_link?: string };
  expect(body.dev_link).toBeTruthy();
  const verify = await call(new URL(body.dev_link!).pathname + new URL(body.dev_link!).search, {
    redirect: 'manual',
  });
  expect(verify.status).toBe(302);
  const cookie = verify.headers.get('set-cookie') ?? '';
  expect(cookie).toContain('HttpOnly');
  const m = /sb_session=([^;]+)/.exec(cookie);
  return `sb_session=${m![1]}`;
}

const json = (cookie: string, method: string, body?: unknown, origin = ORIGIN): RequestInit => ({
  method,
  headers: { cookie, origin, 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

describe('magic-link sign-in', () => {
  it('signs in an allow-listed email and returns /me with a personal space', async () => {
    const cookie = await signIn('owner@example.com');
    const me = (await (await call('/api/v1/me', { headers: { cookie } })).json()) as MeResponse;
    expect(me.user.email).toBe('owner@example.com');
    expect(me.spaces).toEqual([
      expect.objectContaining({
        kind: 'personal',
        role: 'owner',
        vault: { provider: 'managed', repo: null },
      }),
    ]);
  });

  it('does not reveal whether an email is allowed, and gives no link to others', async () => {
    const res = await call('/api/v1/auth/magic-link', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'stranger@example.com' }),
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ sent: true });
  });

  it('magic links work once', async () => {
    const res = await call('/api/v1/auth/magic-link', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'second@example.com' }),
    });
    const link = new URL(((await res.json()) as { dev_link: string }).dev_link);
    expect(
      (await call(link.pathname + link.search, { redirect: 'manual' })).headers.get('set-cookie'),
    ).toContain('sb_session');
    const again = await call(link.pathname + link.search, { redirect: 'manual' });
    expect(again.headers.get('location')).toContain('signin=expired');
  });

  it('rejects cookie-authenticated mutations from foreign origins (CSRF)', async () => {
    const cookie = await signIn('owner@example.com');
    const evil = await call(
      '/api/v1/keys',
      json(cookie, 'POST', { label: 'x' }, 'https://evil.example'),
    );
    expect(evil.status).toBe(401);
    const good = await call('/api/v1/keys', json(cookie, 'POST', { label: 'laptop' }));
    expect(good.status).toBe(201);
  });

  it('logout ends the session', async () => {
    const cookie = await signIn('owner@example.com');
    expect((await call('/api/v1/auth/logout', json(cookie, 'POST'))).status).toBe(204);
    expect((await call('/api/v1/me', { headers: { cookie } })).status).toBe(401);
  });
});

describe('device login (CLI)', () => {
  it('start → approve in browser → poll returns a working key exactly once', async () => {
    const start = await call('/api/v1/auth/device', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client: 'claude-code', machine: 'macbook' }),
    });
    const d = (await start.json()) as DeviceStartResponse;
    expect(d.user_code).toMatch(/^[A-Z]{4}-[A-Z]{4}$/);
    expect(d.verification_uri_complete).toContain(d.user_code);

    const poll = () =>
      call('/api/v1/auth/device/token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ device_code: d.device_code }),
      });
    expect((await poll()).status).toBe(428);

    const cookie = await signIn('owner@example.com');
    const info = await call(`/api/v1/auth/device/${d.user_code.toLowerCase()}`, {
      headers: { cookie },
    });
    expect(await info.json()).toMatchObject({ client: 'claude-code', machine: 'macbook' });
    const approve = await call(
      '/api/v1/auth/device/approve',
      json(cookie, 'POST', { user_code: d.user_code, approve: true }),
    );
    expect(approve.status).toBe(204);

    const granted = await poll();
    expect(granted.status).toBe(200);
    const tok = (await granted.json()) as {
      secret: string;
      key: { client: string; prefix: string };
      mcp_url: string;
    };
    expect(tok.key.client).toBe('claude-code');
    expect(tok.secret.startsWith(tok.key.prefix)).toBe(true);
    expect(tok.mcp_url).toBe('http://app.test/mcp');
    expect((await poll()).status).toBe(410);

    const ctx = await mcp(tok.secret, 'brain_context', {});
    expect(ctx.isError).toBe(false);
  });

  it('a denied request is reported to the CLI', async () => {
    const d = (await (
      await call('/api/v1/auth/device', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client: 'cursor', machine: 'pc' }),
      })
    ).json()) as DeviceStartResponse;
    const cookie = await signIn('owner@example.com');
    await call(
      '/api/v1/auth/device/approve',
      json(cookie, 'POST', { user_code: d.user_code, approve: false }),
    );
    const res = await call('/api/v1/auth/device/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ device_code: d.device_code }),
    });
    expect(res.status).toBe(403);
  });
});

describe('keys', () => {
  it('revocation takes effect on the next request', async () => {
    const { secret, key } = await newUserWithKey();
    expect((await mcp(secret, 'brain_projects', {})).isError).toBe(false);
    const del = await call(`/api/v1/keys/${key.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(del.status).toBe(204);
    const after = await call('/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}` },
      body: '{}',
    });
    expect(after.status).toBe(401);
  });

  it('lists keys without ever returning secrets or hashes', async () => {
    const { secret } = await newUserWithKey();
    const res = await call('/api/v1/keys', { headers: { authorization: `Bearer ${secret}` } });
    const text = await res.text();
    expect(text).not.toContain(secret);
    expect(text).not.toContain('"hash"');
    expect(JSON.parse(text).items[0]).toMatchObject({
      client: 'test-client',
      scopes: ['read', 'write'],
    });
  });

  it('a read-only key cannot mint a write key', async () => {
    const { secret } = await newUserWithKey({ scopes: ['read'] });
    const res = await call('/api/v1/keys', {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'x', scopes: ['read', 'write'] }),
    });
    expect(res.status).toBe(403);
  });
});

describe('REST notes, search and dashboard', () => {
  it('saves with optimistic concurrency, reads with links, searches and builds the dashboard', async () => {
    const cookie = await signIn('owner@example.com');
    const put = (path: string, content: string, base_version: string | null) =>
      call('/api/v1/note', json(cookie, 'PUT', { path, content, base_version }));

    const created = await put(
      'topics/caching.md',
      '# Caching\n\nCache at the index layer. See [[topics/index]].',
      null,
    );
    expect(created.status).toBe(200);
    const { version } = (await created.json()) as { version: string };
    expect((await put('topics/caching.md', '# Caching\n\nnew', null)).status).toBe(409);

    const detail = (await (
      await call('/api/v1/note?path=topics/caching.md', { headers: { cookie } })
    ).json()) as NoteDetail;
    expect(detail).toMatchObject({
      title: 'Caching',
      type: 'topic',
      version,
      links: [{ target: 'topics/index', path: null }],
    });

    const search = await call('/api/v1/search?q=index%20layer&types=topic', {
      headers: { cookie },
    });
    expect(((await search.json()) as { hits: { path: string }[] }).hits[0]?.path).toBe(
      'topics/caching.md',
    );

    const dash = (await (
      await call('/api/v1/dashboard', { headers: { cookie } })
    ).json()) as DashboardResponse;
    expect(dash.stats.topics).toBeGreaterThanOrEqual(1);
    expect(dash.check.broken_links).toContainEqual({
      from: 'topics/caching.md',
      target: 'topics/index',
    });

    const notes = await call('/api/v1/notes?type=topic', { headers: { cookie } });
    expect(
      ((await notes.json()) as { items: { path: string }[] }).items.map((n) => n.path),
    ).toContain('topics/caching.md');
  });

  it('returns RFC 9457 problems for invalid input and unknown routes', async () => {
    const cookie = await signIn('owner@example.com');
    const bad = await call('/api/v1/note', json(cookie, 'PUT', { path: '' }));
    expect(bad.status).toBe(400);
    expect(bad.headers.get('content-type')).toContain('application/problem+json');
    expect(((await bad.json()) as { errors: unknown[] }).errors.length).toBeGreaterThan(0);
    expect((await call('/api/v1/nope', { headers: { cookie } })).status).toBe(404);
    expect((await call('/api/v1/me')).status).toBe(401);
  });
});

describe('import', () => {
  it('imports a Markdown vault in one commit, skipping unsafe or non-Markdown paths', async () => {
    const { secret } = await newUserWithKey();
    const res = await call('/api/v1/import', {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        files: [
          { path: 'Projects/Kitchen.md', content: '# Kitchen\n\nRenovation plan.' },
          { path: 'daily/2026-10-01.md', content: 'Met the plumber.' },
          { path: '.obsidian/app.md', content: 'x' },
          { path: '../escape.md', content: 'x' },
          { path: 'image.png', content: 'x' },
        ],
      }),
    });
    const body = (await res.json()) as {
      imported: number;
      skipped: { path: string }[];
      commit_sha: string;
    };
    expect(body.imported).toBe(2);
    expect(body.skipped.map((s) => s.path).sort()).toEqual([
      '../escape.md',
      '.obsidian/app.md',
      'image.png',
    ]);
    const hits = await mcp(secret, 'brain_search', { query: 'plumber' });
    expect(hits.data.hits[0]?.path).toBe('daily/2026-10-01.md');
  });
});
