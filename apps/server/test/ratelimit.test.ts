import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { call, env, newUserWithKey } from './helpers';

type Overrides = Parameters<typeof call>[2];

/** D1 fixed-window fallback with small limits. */
const D1: Overrides = {
  RATE_LIMITS: 'on',
  RATE_LIMIT_AUTH_PER_MIN: '3',
  RATE_LIMIT_API_PER_MIN: '2',
};

const ip = () => `203.0.113.${Math.floor(Math.random() * 250)}-${crypto.randomUUID()}`;

beforeEach(() => {
  // Pin the clock to the middle of a window so a minute boundary can't reset a counter mid-test.
  const now = Math.floor(Date.now() / 60_000) * 60_000 + 30_000;
  vi.spyOn(Date, 'now').mockReturnValue(now);
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function expect429(res: Response, retryAfter?: number) {
  expect(res.status).toBe(429);
  expect(res.headers.get('content-type')).toContain('application/problem+json');
  const ra = Number(res.headers.get('retry-after'));
  expect(ra).toBeGreaterThan(0);
  expect(ra).toBeLessThanOrEqual(60);
  if (retryAfter !== undefined) expect(ra).toBe(retryAfter);
  expect(await res.json()).toMatchObject({ status: 429, title: 'Too many requests' });
}

describe('rate limiting: D1 fallback', () => {
  it('limits /api/v1/auth/* per IP', async () => {
    const a = ip();
    const get = (who: string) =>
      call('/api/v1/auth/providers', { headers: { 'cf-connecting-ip': who } }, D1);
    for (let i = 0; i < 3; i++) expect((await get(a)).status).toBe(200);
    await expect429(await get(a), 30);
    // Another IP has its own budget.
    expect((await get(ip())).status).toBe(200);
    // IPs are stored hashed.
    const keys = await env.DB.prepare('SELECT key FROM rate_limits').all<{ key: string }>();
    expect(keys.results.some((k) => k.key.includes(a))).toBe(false);
  });

  it('limits magic links per email across IPs', async () => {
    const email = `rl-${crypto.randomUUID()}@example.com`;
    const send = () =>
      call(
        '/api/v1/auth/magic-link',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip() },
          body: JSON.stringify({ email }),
        },
        D1,
      );
    for (let i = 0; i < 3; i++) expect((await send()).status).toBe(202);
    await expect429(await send());
  });

  it('limits passkey sign-up options per email', async () => {
    const email = `rl-${crypto.randomUUID()}@example.com`;
    const opts = () =>
      call(
        '/api/v1/auth/passkey/register/options',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: 'http://app.test',
            'cf-connecting-ip': ip(),
          },
          body: JSON.stringify({ email }),
        },
        { ...D1, SIGNUP_MODE: 'open' },
      );
    for (let i = 0; i < 3; i++) expect((await opts()).status).toBe(200);
    await expect429(await opts());
  });

  it('limits /api/v1/* and /mcp per API key', async () => {
    const { secret } = await newUserWithKey();
    const other = await newUserWithKey();
    const me = (s: string) =>
      call(
        '/api/v1/me',
        { headers: { authorization: `Bearer ${s}`, 'cf-connecting-ip': ip() } },
        D1,
      );
    expect((await me(secret)).status).toBe(200);
    expect((await me(secret)).status).toBe(200);
    await expect429(await me(secret));
    // The same key is also over its budget on /mcp.
    await expect429(
      await call(
        '/mcp',
        { method: 'POST', headers: { authorization: `Bearer ${secret}` }, body: '{}' },
        D1,
      ),
    );
    expect((await me(other.secret)).status).toBe(200);
  });

  it('limits anonymous API calls per IP', async () => {
    const who = ip();
    const anon = () => call('/api/v1/me', { headers: { 'cf-connecting-ip': who } }, D1);
    expect((await anon()).status).toBe(401);
    expect((await anon()).status).toBe(401);
    await expect429(await anon());
  });

  it('is a no-op when RATE_LIMITS is off', async () => {
    const who = ip();
    for (let i = 0; i < 6; i++) {
      const res = await call(
        '/api/v1/auth/providers',
        { headers: { 'cf-connecting-ip': who } },
        { ...D1, RATE_LIMITS: 'off' },
      );
      expect(res.status).toBe(200);
    }
  });
});

describe('rate limiting: Workers Rate Limiting binding', () => {
  it('uses the binding when configured and answers 429 with Retry-After', async () => {
    const seen: string[] = [];
    const limiter = (allow: boolean): RateLimit => ({
      limit: async ({ key }) => {
        seen.push(key);
        return { success: allow };
      },
    });
    const overrides: Overrides = {
      RATE_LIMITS: 'on',
      AUTH_RATE_LIMITER: limiter(false),
      API_RATE_LIMITER: limiter(true),
    };
    await expect429(
      await call('/api/v1/auth/providers', { headers: { 'cf-connecting-ip': ip() } }, overrides),
      60,
    );
    const { secret, key } = await newUserWithKey();
    const ok = await call(
      '/api/v1/me',
      { headers: { authorization: `Bearer ${secret}` } },
      overrides,
    );
    expect(ok.status).toBe(200);
    expect(seen).toContain(`api:key:${key.id}`);
    expect(seen.some((k) => k.startsWith('auth:ip:'))).toBe(true);
    // Nothing was written to the D1 fallback.
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM rate_limits WHERE key = ?')
      .bind(`api:key:${key.id}`)
      .first('n');
    expect(n).toBe(0);
  });
});
