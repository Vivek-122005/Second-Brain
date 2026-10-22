import type { MeResponse } from '@second-brain/schema';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GOOGLE_DISCOVERY_URL, resetOidcCache } from '../src/auth/oidc';
import { safeNext } from '../src/lib/redirect';
import { upsertUserByEmail } from '../src/services/spaces';
import { call, env } from './helpers';
import { b64url } from './webauthn';

/**
 * Google OIDC with Google's discovery, token and JWKS endpoints mocked. `cloudflare:test` no
 * longer ships `fetchMock`, so this is a small fetch mock over `globalThis.fetch`; the worker
 * runs in the same isolate, so its outgoing requests hit it.
 */

const CLIENT_ID = 'test-client.apps.googleusercontent.com';
const GOOGLE: Partial<typeof env> = {
  GOOGLE_CLIENT_ID: CLIENT_ID,
  GOOGLE_CLIENT_SECRET: 'test-secret',
  SIGNUP_MODE: 'open',
};
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

let signingKey: CryptoKeyPair;
let otherKey: CryptoKeyPair;
const KID = 'test-kid-1';

async function rsaKey(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
}

async function jwt(claims: Record<string, unknown>, key = signingKey, kid = KID): Promise<string> {
  const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const input = `${enc({ alg: 'RS256', kid, typ: 'JWT' })}.${enc(claims)}`;
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key.privateKey,
    new TextEncoder().encode(input),
  );
  return `${input}.${b64url(new Uint8Array(sig))}`;
}

interface Mock {
  calls: { url: string; body: string }[];
  /** Builds the ID token the token endpoint returns, given the authorize request's nonce. */
  idToken: (nonce: string) => Promise<string>;
  tokenStatus: number;
}
let mock: Mock;
/** nonce + code_challenge of the last /start, keyed by code we hand back. */
let lastAuthorize: URL | null = null;

beforeAll(async () => {
  signingKey = await rsaKey();
  otherKey = await rsaKey();
});

beforeEach(async () => {
  resetOidcCache();
  const jwk = await crypto.subtle.exportKey('jwk', signingKey.publicKey);
  mock = {
    calls: [],
    tokenStatus: 200,
    idToken: (nonce) => jwt(claims({ nonce })),
  };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const req = new Request(input as RequestInfo, init);
    const body = req.method === 'POST' ? new TextDecoder().decode(await req.arrayBuffer()) : '';
    mock.calls.push({ url: req.url, body });
    if (req.url === GOOGLE_DISCOVERY_URL) {
      return Response.json({
        issuer: 'https://accounts.google.com',
        authorization_endpoint: AUTH_URL,
        token_endpoint: TOKEN_URL,
        jwks_uri: JWKS_URL,
      });
    }
    if (req.url === JWKS_URL) {
      return Response.json({ keys: [{ ...jwk, kid: KID, alg: 'RS256', use: 'sig' }] });
    }
    if (req.url === TOKEN_URL && req.method === 'POST') {
      if (mock.tokenStatus !== 200)
        return Response.json({ error: 'invalid_grant' }, { status: mock.tokenStatus });
      const nonce = lastAuthorize?.searchParams.get('nonce') ?? '';
      return Response.json({
        access_token: 'at',
        id_token: await mock.idToken(nonce),
        token_type: 'Bearer',
      });
    }
    return new Response('unexpected request', { status: 599 });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

let sub = 0;
let currentEmail = '';
function claims(over: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: 'https://accounts.google.com',
    aud: CLIENT_ID,
    azp: CLIENT_ID,
    sub: `google-sub-${sub}`,
    email: currentEmail,
    email_verified: true,
    iat: now,
    exp: now + 3600,
    ...over,
  };
}

beforeEach(() => {
  sub += 1;
  currentEmail = `g-${crypto.randomUUID()}@example.com`;
});

/** GET /start; returns the flow cookie and the authorization URL. */
async function start(redirect?: string, overrides = GOOGLE) {
  const q = redirect === undefined ? '' : `?redirect=${encodeURIComponent(redirect)}`;
  const res = await call(`/api/v1/auth/google/start${q}`, { redirect: 'manual' }, overrides);
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get('location')!);
  lastAuthorize = location;
  const setCookie = res.headers.get('set-cookie') ?? '';
  const m = /sb_oidc=([^;]+)/.exec(setCookie);
  return { location, cookie: m ? `sb_oidc=${m[1]}` : '', setCookie };
}

async function callback(cookie: string, params: Record<string, string>, overrides = GOOGLE) {
  const q = new URLSearchParams(params).toString();
  return call(
    `/api/v1/auth/google/callback?${q}`,
    { redirect: 'manual', headers: cookie ? { cookie } : {} },
    overrides,
  );
}

async function signIn(redirect?: string) {
  const s = await start(redirect);
  const res = await callback(s.cookie, {
    code: 'auth-code',
    state: s.location.searchParams.get('state')!,
  });
  return { res, start: s };
}

const sessionCookie = (res: Response) => {
  const m = /sb_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '');
  return m ? `sb_session=${m[1]}` : '';
};

async function me(cookie: string): Promise<MeResponse> {
  return (await (await call('/api/v1/me', { headers: { cookie } })).json()) as MeResponse;
}

describe('Google sign-in: start', () => {
  it('is off unless GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are set', async () => {
    expect((await call('/api/v1/auth/google/start', { redirect: 'manual' })).status).toBe(404);
    expect(
      (
        await call(
          '/api/v1/auth/google/start',
          { redirect: 'manual' },
          { GOOGLE_CLIENT_ID: CLIENT_ID },
        )
      ).status,
    ).toBe(404);
    expect(await (await call('/api/v1/auth/providers', {}, GOOGLE)).json()).toMatchObject({
      google: true,
    });
  });

  it('redirects to Google with PKCE S256, state and nonce, and sets an HttpOnly flow cookie', async () => {
    const { location, setCookie } = await start('/notes');
    expect(`${location.origin}${location.pathname}`).toBe(AUTH_URL);
    const p = location.searchParams;
    expect(p.get('client_id')).toBe(CLIENT_ID);
    expect(p.get('redirect_uri')).toBe('http://app.test/api/v1/auth/google/callback');
    expect(p.get('response_type')).toBe('code');
    expect(p.get('scope')).toBe('openid email profile');
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(p.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(p.get('state')!.length).toBeGreaterThanOrEqual(32);
    expect(p.get('nonce')!.length).toBeGreaterThanOrEqual(32);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Path=/api/v1/auth/google');
  });
});

describe('Google sign-in: callback', () => {
  it('exchanges the code with the PKCE verifier, creates the account and lands on `redirect`', async () => {
    const { res, start: s } = await signIn('/notes?tab=recent');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/notes?tab=recent');
    const cookie = sessionCookie(res);
    expect(cookie).not.toBe('');
    expect((await me(cookie)).user.email).toBe(currentEmail);

    const token = mock.calls.find((c) => c.url === TOKEN_URL)!;
    const form = new URLSearchParams(token.body);
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code')).toBe('auth-code');
    expect(form.get('client_secret')).toBe('test-secret');
    expect(form.get('redirect_uri')).toBe('http://app.test/api/v1/auth/google/callback');
    const digest = new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(form.get('code_verifier')!)),
    );
    expect(b64url(digest)).toBe(s.location.searchParams.get('code_challenge'));

    const identity = await env.DB.prepare(
      "SELECT * FROM identities WHERE provider = 'google' AND subject = ?",
    )
      .bind(`google-sub-${sub}`)
      .first<{ user_id: string; email: string }>();
    expect(identity).toMatchObject({ email: currentEmail });
    const actions = (
      await env.DB.prepare('SELECT action FROM audit_log WHERE actor_user_id = ? ORDER BY at, id')
        .bind(identity!.user_id)
        .all<{ action: string }>()
    ).results.map((r) => r.action);
    // Same-millisecond entries have no fixed order, so compare as a set.
    expect(actions.sort()).toEqual([
      'auth.email_verified',
      'auth.identity.link',
      'auth.signin',
      'auth.signup',
    ]);
  });

  it('signs the same Google account back in to the same user, and caches discovery and JWKS', async () => {
    const first = await signIn();
    const firstId = (await me(sessionCookie(first.res))).user.id;
    // Even if the Google email changes, the subject decides.
    currentEmail = `changed-${crypto.randomUUID()}@example.com`;
    const again = await signIn();
    expect((await me(sessionCookie(again.res))).user.id).toBe(firstId);
    expect(mock.calls.filter((c) => c.url === JWKS_URL)).toHaveLength(1);
    expect(mock.calls.filter((c) => c.url === GOOGLE_DISCOVERY_URL)).toHaveLength(1);
  });

  it('links to an existing account with the same verified email', async () => {
    const existing = await upsertUserByEmail(env.DB, currentEmail);
    const { res } = await signIn();
    expect((await me(sessionCookie(res))).user.id).toBe(existing.id);
  });

  it('defaults to / and refuses open redirects', async () => {
    for (const evil of [
      'https://evil.example/x',
      '//evil.example',
      '/\\evil.example',
      'javascript:alert(1)',
    ]) {
      const { res } = await signIn(evil);
      expect(res.headers.get('location')).toBe('/');
    }
    expect((await signIn('http://app.test/settings')).res.headers.get('location')).toBe(
      '/settings',
    );
  });

  const failsWith = async (res: Response, outcome = 'failed') => {
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`/?signin=${outcome}`);
    expect(sessionCookie(res)).toBe('');
  };

  it('rejects a wrong state, a missing flow cookie and a replayed flow', async () => {
    const s = await start();
    const state = s.location.searchParams.get('state')!;
    await failsWith(await callback(s.cookie, { code: 'c', state: 'wrong' }));
    // The flow was consumed by the failed attempt: single use.
    await failsWith(await callback(s.cookie, { code: 'c', state }));

    const s2 = await start();
    await failsWith(
      await callback('', { code: 'c', state: s2.location.searchParams.get('state')! }),
    );

    const s3 = await start();
    const ok = await callback(s3.cookie, {
      code: 'c',
      state: s3.location.searchParams.get('state')!,
    });
    expect(sessionCookie(ok)).not.toBe('');
    await failsWith(
      await callback(s3.cookie, { code: 'c', state: s3.location.searchParams.get('state')! }),
    );
  });

  it('reports a cancelled consent and a failed code exchange', async () => {
    const s = await start();
    await failsWith(
      await callback(s.cookie, {
        error: 'access_denied',
        state: s.location.searchParams.get('state')!,
      }),
      'cancelled',
    );
    mock.tokenStatus = 400;
    const s2 = await start();
    await failsWith(
      await callback(s2.cookie, { code: 'c', state: s2.location.searchParams.get('state')! }),
    );
  });

  const cases: [string, (nonce: string) => Promise<string>, string?][] = [
    ['a wrong nonce', () => jwt(claims({ nonce: 'other' }))],
    [
      'a wrong audience',
      (n) => jwt(claims({ nonce: n, aud: 'someone-else', azp: 'someone-else' })),
    ],
    ['a wrong azp', (n) => jwt(claims({ nonce: n, aud: [CLIENT_ID, 'x'], azp: 'x' }))],
    ['a wrong issuer', (n) => jwt(claims({ nonce: n, iss: 'https://evil.example' }))],
    [
      'an expired token',
      (n) => jwt(claims({ nonce: n, exp: Math.floor(Date.now() / 1000) - 3600 })),
    ],
    [
      'a token issued in the future',
      (n) => jwt(claims({ nonce: n, iat: Math.floor(Date.now() / 1000) + 3600 })),
    ],
    ['a signature from another key', (n) => jwt(claims({ nonce: n }), otherKey)],
    ['an unknown key id', (n) => jwt(claims({ nonce: n }), signingKey, 'nope')],
    [
      'alg none',
      async (n) => {
        const t = await jwt(claims({ nonce: n }));
        const [, p] = t.split('.');
        return `${b64url(new TextEncoder().encode(JSON.stringify({ alg: 'none', kid: KID })))}.${p}.`;
      },
    ],
    ['an unverified email', (n) => jwt(claims({ nonce: n, email_verified: false })), 'not_allowed'],
  ];
  for (const [name, token, outcome] of cases) {
    it(`rejects an ID token with ${name}`, async () => {
      mock.idToken = token;
      const { res } = await signIn();
      await failsWith(res, outcome);
    });
  }

  it('honours the signup policy', async () => {
    const s = await start(undefined, { ...GOOGLE, SIGNUP_MODE: 'allowlist' });
    const res = await callback(
      s.cookie,
      { code: 'c', state: s.location.searchParams.get('state')! },
      { ...GOOGLE, SIGNUP_MODE: 'allowlist' },
    );
    await failsWith(res, 'not_allowed');
  });

  it('a Google sign-in on a passkey-created account revokes the earlier credentials first', async () => {
    const user = await upsertUserByEmail(env.DB, currentEmail); // unverified, like a passkey sign-up
    await env.DB.prepare(
      "INSERT INTO passkeys (id, user_id, credential_id, public_key, counter, transports, device_type, backed_up, name, created_at) VALUES ('pky_x', ?, ?, 'k', 0, '[]', 'multiDevice', 1, 'squatter', 0)",
    )
      .bind(user.id, `cred-${crypto.randomUUID()}`)
      .run();
    const { res } = await signIn();
    expect((await me(sessionCookie(res))).user.id).toBe(user.id);
    expect(
      await env.DB.prepare('SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?')
        .bind(user.id)
        .first('n'),
    ).toBe(0);
    // The Google identity just linked survives.
    expect(
      await env.DB.prepare('SELECT COUNT(*) AS n FROM identities WHERE user_id = ?')
        .bind(user.id)
        .first('n'),
    ).toBe(1);
  });
});

describe('safeNext', () => {
  it('keeps same-origin paths and URLs, drops everything else', () => {
    const self = 'https://brain.example.com';
    expect(safeNext('/a/b?c=1#d', self)).toBe('/a/b?c=1#d');
    expect(safeNext('https://brain.example.com/x', self)).toBe('/x');
    expect(safeNext('https://brain.example.com.evil.example/x', self)).toBe('/');
    expect(safeNext('http://brain.example.com/x', self)).toBe('/');
    expect(safeNext('//evil.example', self)).toBe('/');
    expect(safeNext('/\\evil.example', self)).toBe('/');
    expect(safeNext('/\t/evil.example', self)).toBe('/');
    expect(safeNext('notes', self)).toBe('/');
    expect(safeNext('javascript:alert(1)', self)).toBe('/');
    expect(safeNext(undefined, self)).toBe('/');
  });
});
