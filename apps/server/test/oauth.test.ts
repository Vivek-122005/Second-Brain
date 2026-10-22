import type { OAuthGrantsResponse } from '@second-brain/schema';
import { describe, expect, it } from 'vitest';
import { createSession } from '../src/auth/sessions';
import { sha256Hex } from '../src/lib/crypto';
import { s256 } from '../src/oauth/tokens';
import { upsertUserByEmail } from '../src/services/spaces';
import { call, env } from './helpers';

const ORIGIN = 'http://app.test';
const RESOURCE = `${ORIGIN}/mcp`;
const REDIRECT = 'http://127.0.0.1:33418/callback';

let ipCounter = 0;
const freshIp = () => `10.0.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;

async function register(body: Record<string, unknown>, ip = freshIp()): Promise<Response> {
  return call('/oauth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: JSON.stringify(body),
  });
}

async function newClient(extra: Record<string, unknown> = {}) {
  const res = await register({
    client_name: 'Claude Code',
    redirect_uris: [REDIRECT],
    grant_types: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_method: 'none',
    ...extra,
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { client_id: string; client_secret?: string };
}

async function newSession() {
  const user = await upsertUserByEmail(env.DB, `oauth-${crypto.randomUUID()}@example.com`);
  const { token } = await createSession(env.DB, user.id);
  return { user, cookie: `sb_session=${token}` };
}

const VERIFIER = 'a'.repeat(20) + '-._~' + 'Z9'.repeat(12);

function authorizeQuery(clientId: string, challenge: string, extra: Record<string, string> = {}) {
  return new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'xyz',
    scope: 'read write',
    resource: RESOURCE,
    ...extra,
  });
}

const UNESCAPE: Record<string, string> = { amp: '&', quot: '"', lt: '<', gt: '>', '#39': "'" };

/** Reads the consent form's hidden fields, decoding entities in one pass. */
function hiddenFields(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) {
    out[m[1]!] = m[2]!.replace(/&(amp|quot|lt|gt|#39);/g, (_, e: string) => UNESCAPE[e] ?? '');
  }
  return out;
}

async function consent(
  cookie: string,
  fields: Record<string, string>,
  decision: 'approve' | 'deny',
  extra: Record<string, string> = {},
  origin = ORIGIN,
): Promise<Response> {
  return call('/oauth/authorize', {
    method: 'POST',
    redirect: 'manual',
    headers: {
      cookie,
      origin,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ ...fields, decision, ...extra }).toString(),
  });
}

async function token(params: Record<string, string>): Promise<Response> {
  return call('/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
}

/** Runs registration, consent and the code exchange. Returns the tokens and helpers. */
async function connect(opts: { write?: boolean } = {}) {
  const client = await newClient();
  const { user, cookie } = await newSession();
  const challenge = await s256(VERIFIER);
  const page = await call(`/oauth/authorize?${authorizeQuery(client.client_id, challenge)}`, {
    headers: { cookie },
  });
  expect(page.status).toBe(200);
  const fields = hiddenFields(await page.text());
  const res = await consent(
    cookie,
    fields,
    'approve',
    opts.write === false ? {} : { scope_write: '1' },
  );
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get('location')!);
  const code = location.searchParams.get('code')!;
  const tok = await token({
    grant_type: 'authorization_code',
    code,
    code_verifier: VERIFIER,
    client_id: client.client_id,
    redirect_uri: REDIRECT,
    resource: RESOURCE,
  });
  expect(tok.status).toBe(200);
  const body = (await tok.json()) as {
    access_token: string;
    refresh_token: string;
    scope: string;
    expires_in: number;
  };
  return { client, user, cookie, code, location, fields, ...body };
}

const mcpHeaders = (bearer: string) => ({
  authorization: `Bearer ${bearer}`,
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
});

async function toolsList(bearer: string): Promise<Response> {
  return call('/mcp', {
    method: 'POST',
    headers: mcpHeaders(bearer),
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
}

async function callTool(bearer: string, name: string, args: Record<string, unknown>) {
  const res = await call('/mcp', {
    method: 'POST',
    headers: mcpHeaders(bearer),
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  return (await res.json()) as {
    result?: { isError?: boolean; content: { text: string }[] };
    error?: { message: string };
  };
}

describe('OAuth discovery', () => {
  it('serves protected-resource metadata at both paths', async () => {
    for (const path of [
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/mcp',
    ]) {
      const res = await call(path);
      expect(res.status).toBe(200);
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
      expect(await res.json()).toMatchObject({
        resource: RESOURCE,
        authorization_servers: [ORIGIN],
        scopes_supported: ['read', 'write'],
        bearer_methods_supported: ['header'],
      });
    }
  });

  it('serves authorization-server metadata', async () => {
    const res = await call('/.well-known/oauth-authorization-server');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/oauth/authorize`,
      token_endpoint: `${ORIGIN}/oauth/token`,
      registration_endpoint: `${ORIGIN}/oauth/register`,
      revocation_endpoint: `${ORIGIN}/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: expect.arrayContaining(['none']),
    });
  });

  it('points unauthenticated /mcp callers at the metadata', async () => {
    const res = await call('/mcp', { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
    const header = res.headers.get('www-authenticate')!;
    expect(header).toContain(
      `resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
    );
    expect(header).not.toContain('error=');
  });
});

describe('dynamic client registration', () => {
  it('registers a public client', async () => {
    const res = await register({
      client_name: 'Cursor',
      redirect_uris: ['cursor://anysphere.cursor-mcp/oauth/callback', 'https://claude.ai/cb'],
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      client_name: 'Cursor',
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    });
    expect(body.client_id).toMatch(/^ocl_/);
    expect(body.client_secret).toBeUndefined();
  });

  it('accepts loopback http on any port, but no other http', async () => {
    for (const uri of ['http://localhost:9999/cb', 'http://127.0.0.1/cb', 'http://[::1]:1/cb']) {
      expect((await register({ redirect_uris: [uri] })).status).toBe(201);
    }
    for (const uri of [
      'http://example.com/cb',
      'javascript:alert(1)',
      'data:text/html,hi',
      'https://ok.example/cb#frag',
      'https://user:pw@ok.example/cb',
      '/relative',
    ]) {
      const res = await register({ redirect_uris: [uri] });
      expect(res.status, uri).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('invalid_redirect_uri');
    }
  });

  it('rejects bad metadata', async () => {
    const cases = [
      {},
      { redirect_uris: [] },
      { redirect_uris: [REDIRECT], grant_types: ['client_credentials'] },
      { redirect_uris: [REDIRECT], response_types: ['token'] },
      { redirect_uris: [REDIRECT], token_endpoint_auth_method: 'private_key_jwt' },
    ];
    for (const body of cases) {
      const res = await register(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('invalid_client_metadata');
    }
  });

  it('issues a secret to confidential clients and checks it at the token endpoint', async () => {
    const client = await newClient({ token_endpoint_auth_method: 'client_secret_post' });
    expect(client.client_secret).toMatch(/^sb_ocs_/);
    const wrong = await token({
      grant_type: 'refresh_token',
      refresh_token: 'sb_ort_x',
      client_id: client.client_id,
      client_secret: 'sb_ocs_wrong',
    });
    expect(wrong.status).toBe(401);
    expect(((await wrong.json()) as { error: string }).error).toBe('invalid_client');
  });

  it('caps registrations per IP per hour', async () => {
    const ip = '203.0.113.7';
    for (let i = 0; i < 20; i++) {
      expect((await register({ redirect_uris: [REDIRECT] }, ip)).status).toBe(201);
    }
    const res = await register({ redirect_uris: [REDIRECT] }, ip);
    expect(res.status).toBe(429);
    expect((await register({ redirect_uris: [REDIRECT] }, '203.0.113.8')).status).toBe(201);
  });
});

describe('authorization endpoint', () => {
  it('sends people without a session to sign in, then back', async () => {
    const client = await newClient();
    const path = `/oauth/authorize?${authorizeQuery(client.client_id, await s256(VERIFIER))}`;
    const res = await call(path, { redirect: 'manual' });
    expect(res.status).toBe(302);
    const location = res.headers.get('location')!;
    expect(location.startsWith('/login?next=')).toBe(true);
    expect(decodeURIComponent(location.slice('/login?next='.length))).toBe(`${ORIGIN}${path}`);
  });

  it('shows a consent page with the client, redirect host, scopes and space', async () => {
    const client = await newClient({ client_name: '<b>Claude</b>' });
    const { cookie, user } = await newSession();
    const res = await call(
      `/oauth/authorize?${authorizeQuery(client.client_id, await s256(VERIFIER))}`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    const html = await res.text();
    expect(html).toContain('&lt;b&gt;Claude&lt;/b&gt;');
    expect(html).not.toContain('<b>Claude</b>');
    expect(html).toContain('127.0.0.1:33418');
    expect(html).toContain('Read');
    expect(html).toContain('Write');
    expect(html).toContain('Personal');
    expect(html).toContain(user.email);
    expect(hiddenFields(html).csrf).toBeTruthy();
  });

  it('never redirects to an unregistered redirect URI', async () => {
    const client = await newClient();
    const { cookie } = await newSession();
    const res = await call(
      `/oauth/authorize?${authorizeQuery(client.client_id, await s256(VERIFIER), {
        redirect_uri: 'https://evil.example/cb',
      })}`,
      { headers: { cookie }, redirect: 'manual' },
    );
    expect(res.status).toBe(400);
    expect(res.headers.get('location')).toBeNull();
    const unknown = await call(
      `/oauth/authorize?${authorizeQuery('ocl_00000000000000000000000000', 'x'.repeat(43))}`,
      { headers: { cookie }, redirect: 'manual' },
    );
    expect(unknown.status).toBe(400);
  });

  it('accepts a registered loopback redirect on another port', async () => {
    const client = await newClient();
    const { cookie } = await newSession();
    const res = await call(
      `/oauth/authorize?${authorizeQuery(client.client_id, await s256(VERIFIER), {
        redirect_uri: 'http://127.0.0.1:50000/callback',
      })}`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(200);
  });

  it('requires S256 PKCE and a valid resource, reporting errors to the client', async () => {
    const client = await newClient();
    const { cookie } = await newSession();
    const cases: [Record<string, string>, string][] = [
      [{ code_challenge_method: 'plain' }, 'invalid_request'],
      [{ code_challenge: '' }, 'invalid_request'],
      [{ response_type: 'token' }, 'unsupported_response_type'],
      [{ resource: 'https://other.example/mcp' }, 'invalid_target'],
    ];
    for (const [extra, error] of cases) {
      const res = await call(
        `/oauth/authorize?${authorizeQuery(client.client_id, await s256(VERIFIER), extra)}`,
        { headers: { cookie }, redirect: 'manual' },
      );
      expect(res.status).toBe(302);
      const loc = new URL(res.headers.get('location')!);
      expect(`${loc.origin}${loc.pathname}`).toBe(REDIRECT);
      expect(loc.searchParams.get('error')).toBe(error);
      expect(loc.searchParams.get('state')).toBe('xyz');
      expect(loc.searchParams.get('iss')).toBe(ORIGIN);
    }
  });

  it('protects the consent POST against CSRF', async () => {
    const client = await newClient();
    const { cookie } = await newSession();
    const page = await call(
      `/oauth/authorize?${authorizeQuery(client.client_id, await s256(VERIFIER))}`,
      { headers: { cookie } },
    );
    const fields = hiddenFields(await page.text());

    const crossSite = await consent(cookie, fields, 'approve', {}, 'https://evil.example');
    expect(crossSite.status).toBe(403);
    const noToken = await consent(cookie, { ...fields, csrf: '' }, 'approve');
    expect(noToken.status).toBe(403);
    const other = await newSession();
    const stolen = await consent(other.cookie, fields, 'approve');
    expect(stolen.status).toBe(403);
    const noSession = await consent('', fields, 'approve');
    expect(noSession.status).toBe(302);
    const next = decodeURIComponent(
      noSession.headers.get('location')!.slice('/login?next='.length),
    );
    expect(next.startsWith(`${ORIGIN}/oauth/authorize?`)).toBe(true);
    expect(new URL(next).searchParams.get('client_id')).toBe(client.client_id);
    expect(new URL(next).searchParams.get('csrf')).toBeNull();
  });

  it('redirects with access_denied when the user denies', async () => {
    const client = await newClient();
    const { cookie } = await newSession();
    const page = await call(
      `/oauth/authorize?${authorizeQuery(client.client_id, await s256(VERIFIER))}`,
      { headers: { cookie } },
    );
    const res = await consent(cookie, hiddenFields(await page.text()), 'deny');
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location')!);
    expect(loc.searchParams.get('error')).toBe('access_denied');
    expect(loc.searchParams.get('code')).toBeNull();
  });
});

describe('authorization code + PKCE', () => {
  it('rejects a wrong verifier, then exchanges once, and rejects reuse', async () => {
    const client = await newClient();
    const { cookie } = await newSession();
    const page = await call(
      `/oauth/authorize?${authorizeQuery(client.client_id, await s256(VERIFIER))}`,
      { headers: { cookie } },
    );
    const res = await consent(cookie, hiddenFields(await page.text()), 'approve', {
      scope_write: '1',
    });
    const loc = new URL(res.headers.get('location')!);
    expect(loc.searchParams.get('state')).toBe('xyz');
    expect(loc.searchParams.get('iss')).toBe(ORIGIN);
    const code = loc.searchParams.get('code')!;
    expect(code).toMatch(/^sb_oac_/);

    const base = {
      grant_type: 'authorization_code',
      code,
      client_id: client.client_id,
      redirect_uri: REDIRECT,
    };
    const wrong = await token({ ...base, code_verifier: 'b'.repeat(43) });
    expect(wrong.status).toBe(400);
    expect(((await wrong.json()) as { error: string }).error).toBe('invalid_grant');

    const otherClient = await newClient();
    const stolen = await token({
      ...base,
      client_id: otherClient.client_id,
      code_verifier: VERIFIER,
    });
    expect(stolen.status).toBe(400);

    const ok = await token({ ...base, code_verifier: VERIFIER });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toBe('no-store');
    const body = (await ok.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'read write' });
    expect(body.access_token).toMatch(/^sb_oat_/);
    expect(body.refresh_token).toMatch(/^sb_ort_/);
    expect((await toolsList(body.access_token as string)).status).toBe(200);

    const replay = await token({ ...base, code_verifier: VERIFIER });
    expect(replay.status).toBe(400);
    expect(((await replay.json()) as { error: string }).error).toBe('invalid_grant');
    // A replayed code revokes the tokens it minted.
    expect((await toolsList(body.access_token as string)).status).toBe(401);
  });

  it('expires codes after 60 seconds', async () => {
    const client = await newClient();
    const { cookie } = await newSession();
    const page = await call(
      `/oauth/authorize?${authorizeQuery(client.client_id, await s256(VERIFIER))}`,
      { headers: { cookie } },
    );
    const res = await consent(cookie, hiddenFields(await page.text()), 'approve');
    const code = new URL(res.headers.get('location')!).searchParams.get('code')!;
    await env.DB.prepare('UPDATE oauth_codes SET expires_at = ? WHERE code_hash = ?')
      .bind(Date.now() - 1, await sha256Hex(code))
      .run();
    const tok = await token({
      grant_type: 'authorization_code',
      code,
      code_verifier: VERIFIER,
      client_id: client.client_id,
    });
    expect(tok.status).toBe(400);
  });
});

describe('MCP with OAuth tokens', () => {
  it('accepts a valid token with the granted scopes and client name', async () => {
    const { access_token, user } = await connect();
    const list = await toolsList(access_token);
    expect(list.status).toBe(200);
    const saved = await callTool(access_token, 'brain_write', {
      path: 'inbox/oauth.md',
      content: '# From OAuth\n\nHello.',
      mode: 'create',
    });
    expect(saved.error).toBeUndefined();
    expect(saved.result?.isError ?? false).toBe(false);
    // The commit is attributed to the user and the OAuth client's name.
    const row = await env.DB.prepare(
      `SELECT c.author, c.message FROM vault_commits c JOIN spaces s ON s.id = c.space_id
       WHERE s.owner_user_id = ? ORDER BY c.created_at DESC LIMIT 1`,
    )
      .bind(user.id)
      .first<{ author: string; message: string }>();
    expect(row?.author).toContain(user.email);
    expect(row?.message).toContain('Second-Brain-Client: Claude Code');
  });

  it('enforces a read-only grant', async () => {
    const { access_token, scope } = await connect({ write: false });
    expect(scope).toBe('read');
    const res = await callTool(access_token, 'brain_write', {
      path: 'inbox/nope.md',
      content: '# No',
      mode: 'create',
    });
    const text = res.error?.message ?? res.result?.content[0]?.text ?? '';
    expect(res.error !== undefined || res.result?.isError === true).toBe(true);
    expect(text).toContain('write');
  });

  it('rejects an expired token with invalid_token', async () => {
    const { access_token } = await connect();
    await env.DB.prepare('UPDATE oauth_tokens SET expires_at = ? WHERE token_hash = ?')
      .bind(Date.now() - 1, await sha256Hex(access_token))
      .run();
    const res = await toolsList(access_token);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('error="invalid_token"');
    expect(res.headers.get('www-authenticate')).toContain('resource_metadata=');
  });

  it('binds tokens to the /mcp audience, so the REST API rejects them', async () => {
    const { access_token } = await connect();
    const res = await call('/api/v1/me', { headers: { authorization: `Bearer ${access_token}` } });
    expect(res.status).toBe(401);
  });
});

describe('refresh tokens', () => {
  it('rotates, and replaying a rotated token revokes the whole family', async () => {
    const first = await connect();
    const r1 = await token({
      grant_type: 'refresh_token',
      refresh_token: first.refresh_token,
      client_id: first.client.client_id,
    });
    expect(r1.status).toBe(200);
    const second = (await r1.json()) as { access_token: string; refresh_token: string };
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect((await toolsList(second.access_token)).status).toBe(200);

    const replay = await token({
      grant_type: 'refresh_token',
      refresh_token: first.refresh_token,
      client_id: first.client.client_id,
    });
    expect(replay.status).toBe(400);
    expect(((await replay.json()) as { error: string }).error).toBe('invalid_grant');

    // The whole family is gone: the newest refresh token and every access token.
    const after = await token({
      grant_type: 'refresh_token',
      refresh_token: second.refresh_token,
      client_id: first.client.client_id,
    });
    expect(after.status).toBe(400);
    expect((await toolsList(second.access_token)).status).toBe(401);
    expect((await toolsList(first.access_token)).status).toBe(401);

    const actions = await env.DB.prepare(
      'SELECT action FROM audit_log WHERE actor_user_id = ? ORDER BY at, id',
    )
      .bind(first.user.id)
      .all<{ action: string }>();
    expect(actions.results.map((a) => a.action)).toEqual([
      'oauth.consent',
      'oauth.token.issue',
      'oauth.token.refresh',
      'oauth.refresh.reuse',
    ]);
  });

  it('cannot widen scopes or be used by another client', async () => {
    const first = await connect({ write: false });
    const widen = await token({
      grant_type: 'refresh_token',
      refresh_token: first.refresh_token,
      client_id: first.client.client_id,
      scope: 'read write',
    });
    expect(widen.status).toBe(400);
    expect(((await widen.json()) as { error: string }).error).toBe('invalid_scope');
    const other = await newClient();
    const stolen = await token({
      grant_type: 'refresh_token',
      refresh_token: first.refresh_token,
      client_id: other.client_id,
    });
    expect(stolen.status).toBe(400);
  });
});

describe('revocation', () => {
  it('revokes an access token', async () => {
    const t = await connect();
    const res = await call('/oauth/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        token: t.access_token,
        token_type_hint: 'access_token',
        client_id: t.client.client_id,
      }).toString(),
    });
    expect(res.status).toBe(200);
    expect((await toolsList(t.access_token)).status).toBe(401);
  });

  it('revokes a refresh token and its family, and ignores unknown tokens', async () => {
    const t = await connect();
    const res = await call('/oauth/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: t.refresh_token }).toString(),
    });
    expect(res.status).toBe(200);
    expect((await toolsList(t.access_token)).status).toBe(401);
    const refresh = await token({
      grant_type: 'refresh_token',
      refresh_token: t.refresh_token,
      client_id: t.client.client_id,
    });
    expect(refresh.status).toBe(400);

    const unknown = await call('/oauth/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: 'sb_oat_unknown' }).toString(),
    });
    expect(unknown.status).toBe(200);
  });
});

describe('connected apps', () => {
  it('lists and disconnects grants for the signed-in user', async () => {
    const t = await connect();
    const list = await call('/api/v1/oauth/grants', { headers: { cookie: t.cookie } });
    expect(list.status).toBe(200);
    const body = (await list.json()) as OAuthGrantsResponse;
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      client_id: t.client.client_id,
      client_name: 'Claude Code',
      redirect_hosts: ['127.0.0.1'],
      scopes: ['read', 'write'],
    });

    const other = await newSession();
    const foreign = await call(`/api/v1/oauth/grants/${body.items[0]!.id}`, {
      method: 'DELETE',
      headers: { cookie: other.cookie, origin: ORIGIN },
    });
    expect(foreign.status).toBe(404);

    const del = await call(`/api/v1/oauth/grants/${body.items[0]!.id}`, {
      method: 'DELETE',
      headers: { cookie: t.cookie, origin: ORIGIN },
    });
    expect(del.status).toBe(204);
    expect((await toolsList(t.access_token)).status).toBe(401);
    const refresh = await token({
      grant_type: 'refresh_token',
      refresh_token: t.refresh_token,
      client_id: t.client.client_id,
    });
    expect(refresh.status).toBe(400);
    const empty = (await (
      await call('/api/v1/oauth/grants', { headers: { cookie: t.cookie } })
    ).json()) as OAuthGrantsResponse;
    expect(empty.items).toHaveLength(0);
  });

  it('requires sign-in', async () => {
    expect((await call('/api/v1/oauth/grants')).status).toBe(401);
  });
});
