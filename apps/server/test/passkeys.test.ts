import type {
  AuthProvidersResponse,
  MeResponse,
  Page,
  Passkey,
  PasskeyVerifyResponse,
} from '@second-brain/schema';
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/server';
import { describe, expect, it } from 'vitest';
import { counterIsValid } from '../src/auth/passkeys';
import { call, env } from './helpers';
import { fromB64url, SoftAuthenticator } from './webauthn';

const ORIGIN = 'http://app.test';
/** Open sign-up, so each test can use its own fresh email. */
const OPEN = { SIGNUP_MODE: 'open' as const };

type Overrides = Parameters<typeof call>[2];

const post = (path: string, body: unknown, cookie?: string, overrides: Overrides = OPEN) =>
  call(
    path,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: ORIGIN,
        ...(cookie ? { cookie } : {}),
      },
      body: body === undefined ? '' : JSON.stringify(body),
    },
    overrides,
  );

const cookieFrom = (res: Response): string => {
  const m = /sb_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '');
  return m ? `sb_session=${m[1]}` : '';
};

const freshEmail = () => `pk-${crypto.randomUUID()}@example.com`;

/** Signs up a new account with a passkey and returns the session cookie. */
async function signUp(email = freshEmail(), auth?: SoftAuthenticator, overrides: Overrides = OPEN) {
  const a = auth ?? (await SoftAuthenticator.create());
  const opts = await post(
    '/api/v1/auth/passkey/register/options',
    { email, name: 'Laptop' },
    undefined,
    overrides,
  );
  expect(opts.status, await opts.clone().text()).toBe(200);
  const options = (await opts.json()) as PublicKeyCredentialCreationOptionsJSON;
  const verify = await post(
    '/api/v1/auth/passkey/register/verify',
    { response: await a.register(options) },
    undefined,
    overrides,
  );
  expect(verify.status, await verify.clone().text()).toBe(200);
  const body = (await verify.json()) as PasskeyVerifyResponse;
  return { auth: a, cookie: cookieFrom(verify), body, email, options };
}

async function login(a: SoftAuthenticator, o: Parameters<SoftAuthenticator['login']>[1] = {}) {
  const options = await (await post('/api/v1/auth/passkey/login/options', undefined)).json();
  return post('/api/v1/auth/passkey/login/verify', { response: await a.login(options, o) });
}

async function magicLinkSignIn(email: string, overrides: Overrides = OPEN): Promise<string> {
  const res = await post('/api/v1/auth/magic-link', { email }, undefined, overrides);
  const link = new URL(((await res.json()) as { dev_link: string }).dev_link);
  const verify = await call(link.pathname + link.search, { redirect: 'manual' }, overrides);
  return cookieFrom(verify);
}

async function auditActions(userId: string): Promise<string[]> {
  const r = await env.DB.prepare(
    'SELECT action FROM audit_log WHERE actor_user_id = ? ORDER BY at, id',
  )
    .bind(userId)
    .all<{ action: string }>();
  return r.results.map((x) => x.action);
}

async function me(cookie: string): Promise<MeResponse> {
  const res = await call('/api/v1/me', { headers: { cookie } });
  expect(res.status).toBe(200);
  return (await res.json()) as MeResponse;
}

describe('providers', () => {
  it('reports the sign-in methods this server offers', async () => {
    const res = await call('/api/v1/auth/providers');
    expect((await res.json()) as AuthProvidersResponse).toEqual({
      passkey: true,
      google: false,
      magic_link: true,
    });
    const prod = await call(
      '/api/v1/auth/providers',
      {},
      {
        ENVIRONMENT: 'production',
        GOOGLE_CLIENT_ID: 'id',
        GOOGLE_CLIENT_SECRET: 'secret',
      },
    );
    expect(await prod.json()).toEqual({ passkey: false, google: true, magic_link: false });
  });
});

describe('passkey sign-up and sign-in', () => {
  it('signs up a new account with email + passkey and sets the session cookie', async () => {
    const { cookie, body, email, options } = await signUp();
    expect(body.verified).toBe(true);
    expect(body.passkey).toMatchObject({ name: 'Laptop', transports: ['internal', 'hybrid'] });
    expect(options).toMatchObject({
      rp: { id: 'app.test', name: 'Second Brain' },
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    });
    const m = await me(cookie);
    expect(m.user.email).toBe(email);
    expect(m.spaces[0]).toMatchObject({ kind: 'personal', role: 'owner' });
    // The WebAuthn user handle is the user id, not the email.
    expect(new TextDecoder().decode(fromB64url(options.user.id))).toBe(m.user.id);
    expect((await auditActions(m.user.id)).sort()).toEqual([
      'auth.passkey.register',
      'auth.signin',
      'auth.signup',
    ]);
  });

  it('signs in with a discoverable credential, no email needed', async () => {
    const { auth, cookie } = await signUp();
    const userId = (await me(cookie)).user.id;
    const options = (await (
      await post('/api/v1/auth/passkey/login/options', undefined)
    ).json()) as PublicKeyCredentialRequestOptionsJSON;
    expect(options.allowCredentials).toEqual([]);
    expect(options.userVerification).toBe('required');
    const res = await post('/api/v1/auth/passkey/login/verify', {
      response: await auth.login(options),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ verified: true });
    const m = await me(cookieFrom(res));
    expect(m.user.id).toBe(userId);
    const row = await env.DB.prepare('SELECT last_used_at FROM passkeys WHERE credential_id = ?')
      .bind(auth.id)
      .first<{ last_used_at: number | null }>();
    expect(row?.last_used_at).toBeTypeOf('number');
  });

  it('challenges are single-use', async () => {
    const a = await SoftAuthenticator.create();
    const options = await (
      await post('/api/v1/auth/passkey/register/options', { email: freshEmail() })
    ).json();
    const response = await a.register(options);
    expect((await post('/api/v1/auth/passkey/register/verify', { response })).status).toBe(200);
    const again = await post('/api/v1/auth/passkey/register/verify', { response });
    expect(again.status).toBe(400);
    expect(await again.json()).toMatchObject({ verified: false, title: 'Passkey request expired' });

    const loginOpts = await (await post('/api/v1/auth/passkey/login/options', undefined)).json();
    const assertion = await a.login(loginOpts);
    expect((await post('/api/v1/auth/passkey/login/verify', { response: assertion })).status).toBe(
      200,
    );
    const replay = await post('/api/v1/auth/passkey/login/verify', { response: assertion });
    expect(replay.status).toBe(400);
    expect(cookieFrom(replay)).toBe('');
  });

  it('challenges expire after five minutes', async () => {
    const { auth } = await signUp();
    const options = (await (
      await post('/api/v1/auth/passkey/login/options', undefined)
    ).json()) as PublicKeyCredentialRequestOptionsJSON;
    const row = await env.DB.prepare(
      'SELECT created_at, expires_at FROM webauthn_challenges WHERE challenge = ?',
    )
      .bind(options.challenge)
      .first<{ created_at: number; expires_at: number }>();
    expect(row!.expires_at - row!.created_at).toBe(5 * 60_000);
    await env.DB.prepare('UPDATE webauthn_challenges SET expires_at = ? WHERE challenge = ?')
      .bind(Date.now() - 1, options.challenge)
      .run();
    const res = await post('/api/v1/auth/passkey/login/verify', {
      response: await auth.login(options),
    });
    expect(res.status).toBe(400);
  });

  it('a registration challenge cannot be used to sign in, and vice versa', async () => {
    const { auth } = await signUp();
    const regOpts = (await (
      await post('/api/v1/auth/passkey/register/options', { email: freshEmail() })
    ).json()) as PublicKeyCredentialCreationOptionsJSON;
    const res = await post('/api/v1/auth/passkey/login/verify', {
      response: await auth.login({ challenge: regOpts.challenge, rpId: 'app.test' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects a response for another origin or RP ID, a bad signature and an unknown passkey', async () => {
    const { auth } = await signUp();
    expect((await login(auth, { origin: 'https://evil.example' })).status).toBe(401);
    expect((await login(auth, { rpId: 'evil.example' })).status).toBe(401);
    expect((await login(auth, { wrongKey: true })).status).toBe(401);
    expect((await login(auth, { userHandle: 'dXNyX25vYm9keQ' })).status).toBe(401);
    const stranger = await SoftAuthenticator.create();
    stranger.userHandle = auth.userHandle;
    const unknown = await login(stranger);
    expect(unknown.status).toBe(401);
    expect(await unknown.json()).toMatchObject({ verified: false });
    // The real one still works afterwards.
    expect((await login(auth)).status).toBe(200);
  });

  it('a registration from a foreign origin is rejected', async () => {
    const a = await SoftAuthenticator.create();
    const options = await (
      await post('/api/v1/auth/passkey/register/options', { email: freshEmail() })
    ).json();
    const res = await post('/api/v1/auth/passkey/register/verify', {
      response: await a.register(options, { origin: 'https://evil.example' }),
    });
    expect(res.status).toBe(400);
  });

  it('requires our own Origin on passkey POSTs (login CSRF)', async () => {
    const res = await call(
      '/api/v1/auth/passkey/login/options',
      { method: 'POST', headers: { origin: 'https://evil.example' } },
      OPEN,
    );
    expect(res.status).toBe(403);
    const none = await call('/api/v1/auth/passkey/login/options', { method: 'POST' }, OPEN);
    expect(none.status).toBe(403);
  });
});

describe('signature counter', () => {
  it('accepts increasing counters and refuses a counter that goes backwards or repeats', async () => {
    const a = await SoftAuthenticator.create(ORIGIN, false);
    a.counter = 1;
    const { cookie } = await signUp(freshEmail(), a);
    const userId = (await me(cookie)).user.id;

    expect((await login(a, { counter: 5 })).status).toBe(200);
    const repeat = await login(a, { counter: 5 });
    expect(repeat.status).toBe(401);
    expect(await repeat.json()).toMatchObject({ verified: false, title: 'Passkey rejected' });
    expect((await login(a, { counter: 3 })).status).toBe(401);
    expect((await login(a, { counter: 6 })).status).toBe(200);

    const row = await env.DB.prepare('SELECT counter FROM passkeys WHERE credential_id = ?')
      .bind(a.id)
      .first<{ counter: number }>();
    expect(row?.counter).toBe(6);
    expect(
      (await auditActions(userId)).filter((x) => x === 'auth.passkey.counter_regression'),
    ).toHaveLength(2);
  });

  it('authenticators without a counter (always 0) keep working', async () => {
    const { auth } = await signUp();
    expect((await login(auth)).status).toBe(200);
    expect((await login(auth)).status).toBe(200);
  });

  it('a counter that drops to zero after being used is refused', () => {
    expect(counterIsValid(0, 0)).toBe(true);
    expect(counterIsValid(0, 1)).toBe(true);
    expect(counterIsValid(4, 5)).toBe(true);
    expect(counterIsValid(5, 5)).toBe(false);
    expect(counterIsValid(5, 0)).toBe(false);
  });
});

describe('sign-up policy', () => {
  it('honours the allow-list (SIGNUP_MODE=allowlist)', async () => {
    const res = await post(
      '/api/v1/auth/passkey/register/options',
      { email: 'stranger@example.com' },
      undefined,
      {},
    );
    expect(res.status).toBe(403);
    const listed = `listed-${crypto.randomUUID()}@example.com`;
    const ok = await post('/api/v1/auth/passkey/register/options', { email: listed }, undefined, {
      ALLOWED_EMAILS: `someone@example.com, ${listed.toUpperCase()}`,
    });
    expect(ok.status).toBe(200);
  });

  it('re-checks the policy at verify time', async () => {
    const email = freshEmail();
    const a = await SoftAuthenticator.create();
    const options = await (await post('/api/v1/auth/passkey/register/options', { email })).json();
    const res = await post(
      '/api/v1/auth/passkey/register/verify',
      { response: await a.register(options) },
      undefined,
      {},
    );
    expect(res.status).toBe(403);
  });

  it('refuses to attach a passkey to an existing account by email alone', async () => {
    const { email } = await signUp();
    const res = await post('/api/v1/auth/passkey/register/options', { email });
    expect(res.status).toBe(409);
  });

  it('needs an email when not signed in', async () => {
    const res = await post('/api/v1/auth/passkey/register/options', {});
    expect(res.status).toBe(400);
  });

  it('refuses passkey sign-in for an account no longer on the allow-list', async () => {
    const { auth } = await signUp();
    const options = await (await post('/api/v1/auth/passkey/login/options', undefined)).json();
    const res = await post(
      '/api/v1/auth/passkey/login/verify',
      { response: await auth.login(options) },
      undefined,
      {},
    );
    expect(res.status).toBe(403);
    expect(cookieFrom(res)).toBe('');
  });
});

describe('managing passkeys', () => {
  it('a signed-in user adds, lists, renames and deletes passkeys', async () => {
    const { cookie, auth } = await signUp();
    const second = await SoftAuthenticator.create();
    const opts = await post('/api/v1/auth/passkey/register/options', undefined, cookie);
    expect(opts.status).toBe(200);
    const options = (await opts.json()) as PublicKeyCredentialCreationOptionsJSON;
    expect(options.excludeCredentials?.map((c) => c.id)).toEqual([auth.id]);
    const added = await post(
      '/api/v1/auth/passkey/register/verify',
      { response: await second.register(options), name: 'Phone' },
      cookie,
    );
    expect(added.status).toBe(200);
    // Adding a passkey doesn't start a new session.
    expect(cookieFrom(added)).toBe('');

    const list = (await (
      await call('/api/v1/auth/passkeys', { headers: { cookie } })
    ).json()) as Page<Passkey>;
    expect(list.items.map((p) => p.name)).toEqual(['Laptop', 'Phone']);
    expect(JSON.stringify(list)).not.toContain('public_key');

    const phone = list.items[1]!;
    const renamed = await call(`/api/v1/auth/passkeys/${phone.id}`, {
      method: 'PATCH',
      headers: { cookie, origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Pixel' }),
    });
    expect(((await renamed.json()) as Passkey).name).toBe('Pixel');

    const del = await call(`/api/v1/auth/passkeys/${phone.id}`, {
      method: 'DELETE',
      headers: { cookie, origin: ORIGIN },
    });
    expect(del.status).toBe(204);
    // The deleted passkey no longer signs in.
    expect((await login(second)).status).toBe(401);
    const userId = (await me(cookie)).user.id;
    expect(await auditActions(userId)).toEqual(
      expect.arrayContaining([
        'auth.passkey.register',
        'auth.passkey.rename',
        'auth.passkey.delete',
      ]),
    );
  });

  it("can't touch another user's passkeys", async () => {
    const alice = await signUp();
    const bob = await signUp();
    const alicePk = alice.body.passkey!;
    const headers = { cookie: bob.cookie, origin: ORIGIN, 'content-type': 'application/json' };
    expect(
      (
        await call(`/api/v1/auth/passkeys/${alicePk.id}`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ name: 'x' }),
        })
      ).status,
    ).toBe(404);
    expect(
      (await call(`/api/v1/auth/passkeys/${alicePk.id}`, { method: 'DELETE', headers })).status,
    ).toBe(404);
    const bobList = (await (
      await call('/api/v1/auth/passkeys', { headers: { cookie: bob.cookie } })
    ).json()) as Page<Passkey>;
    expect(bobList.items.map((p) => p.id)).not.toContain(alicePk.id);
  });

  it('a registration challenge issued to one user cannot be completed by another', async () => {
    const alice = await signUp();
    const bob = await signUp();
    const options = await (
      await post('/api/v1/auth/passkey/register/options', undefined, alice.cookie)
    ).json();
    const a = await SoftAuthenticator.create();
    const res = await post(
      '/api/v1/auth/passkey/register/verify',
      { response: await a.register(options) },
      bob.cookie,
    );
    expect(res.status).toBe(403);
  });

  it('never deletes the last sign-in method', async () => {
    // Production without an email provider: no magic links, so passkeys are all there is.
    const prod = { ...OPEN, ENVIRONMENT: 'production' as const, WEBAUTHN_RP_ID: 'app.test' };
    const { cookie, body } = await signUp(freshEmail(), undefined, prod);
    const del = (id: string) =>
      call(
        `/api/v1/auth/passkeys/${id}`,
        { method: 'DELETE', headers: { cookie, origin: ORIGIN } },
        prod,
      );
    const last = await del(body.passkey!.id);
    expect(last.status).toBe(409);

    const second = await SoftAuthenticator.create();
    const options = await (
      await post('/api/v1/auth/passkey/register/options', undefined, cookie, prod)
    ).json();
    await post(
      '/api/v1/auth/passkey/register/verify',
      { response: await second.register(options) },
      cookie,
      prod,
    );
    expect((await del(body.passkey!.id)).status).toBe(204);
    const list = (await (
      await call('/api/v1/auth/passkeys', { headers: { cookie } }, prod)
    ).json()) as Page<Passkey>;
    expect(list.items).toHaveLength(1);
    expect((await del(list.items[0]!.id)).status).toBe(409);

    // With magic links available, removing every passkey is fine.
    expect(
      (
        await call(`/api/v1/auth/passkeys/${list.items[0]!.id}`, {
          method: 'DELETE',
          headers: { cookie, origin: ORIGIN },
        })
      ).status,
    ).toBe(204);
  });

  it('API keys cannot manage passkeys', async () => {
    const { cookie } = await signUp();
    const created = await call('/api/v1/keys', {
      method: 'POST',
      headers: { cookie, origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'cli' }),
    });
    const { secret } = (await created.json()) as { secret: string };
    const res = await call('/api/v1/auth/passkeys', {
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(res.status).toBe(403);
  });
});

describe('account pre-hijacking', () => {
  it('the first email proof on a passkey-created account revokes the earlier credentials', async () => {
    const { auth, cookie, email } = await signUp();
    const userId = (await me(cookie)).user.id;
    // The real owner of the address signs in by magic link.
    const ownerCookie = await magicLinkSignIn(email);
    expect((await me(ownerCookie)).user.id).toBe(userId);
    // The squatter's passkey and session are gone.
    expect((await login(auth)).status).toBe(401);
    expect((await call('/api/v1/me', { headers: { cookie } })).status).toBe(401);
    expect(await auditActions(userId)).toContain('auth.email_verified');

    // Later magic-link sign-ins don't revoke anything.
    const second = await SoftAuthenticator.create();
    const options = await (
      await post('/api/v1/auth/passkey/register/options', undefined, ownerCookie)
    ).json();
    await post(
      '/api/v1/auth/passkey/register/verify',
      { response: await second.register(options) },
      ownerCookie,
    );
    await magicLinkSignIn(email);
    expect((await login(second)).status).toBe(200);
  });
});

describe('magic link next', () => {
  async function landing(next: unknown): Promise<string | null> {
    const email = freshEmail();
    const res = await post('/api/v1/auth/magic-link', { email, next }, undefined, OPEN);
    const link = new URL(((await res.json()) as { dev_link: string }).dev_link);
    const verify = await call(link.pathname + link.search, { redirect: 'manual' }, OPEN);
    expect(verify.status).toBe(302);
    return verify.headers.get('location');
  }

  it('lands on a same-origin destination and nowhere else', async () => {
    expect(await landing('/device?code=WDJB-MJHT')).toBe('/device?code=WDJB-MJHT');
    expect(await landing('http://app.test/notes#x')).toBe('/notes#x');
    expect(await landing('https://evil.example/phish')).toBe('/');
    expect(await landing('//evil.example')).toBe('/');
    expect(await landing('/\\evil.example')).toBe('/');
    expect(await landing('javascript:alert(1)')).toBe('/');
    expect(await landing(undefined)).toBe('/');
  });
});
