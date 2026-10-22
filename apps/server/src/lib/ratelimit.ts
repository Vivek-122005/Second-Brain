import type { Context, MiddlewareHandler } from 'hono';
import type { AppEnv } from '../auth/principal';
import type { Env } from '../env';
import { sha256Hex } from './crypto';
import { HttpError } from './http';

/**
 * Rate limiting (ADR-0007, HLD §7).
 *
 * - `auth`: strict, per IP on every /api/v1/auth/* request and per email where a request names
 *   one (magic link, passkey sign-up).
 * - `api`: per API key (or per user for web sessions, per IP when anonymous) on /api/v1/* and /mcp.
 *
 * Backends, in order: the Workers Rate Limiting binding when configured (AUTH_RATE_LIMITER /
 * API_RATE_LIMITER, limits set in wrangler.jsonc); otherwise a fixed-window counter in D1
 * (limits from RATE_LIMIT_*_PER_MIN); or nothing when RATE_LIMITS = "off" (tests).
 * Over the limit: 429 problem+json with Retry-After.
 *
 * IPs and emails are hashed before they are used as keys, so neither is stored (security.md §5).
 */

export type Bucket = 'auth' | 'api';

export const DEFAULT_LIMITS: Record<Bucket, number> = { auth: 30, api: 600 };
const WINDOW_MS = 60_000;

export type LimitResult = { ok: true } | { ok: false; retryAfter: number };

function limitFor(env: Env, bucket: Bucket): number {
  const raw = bucket === 'auth' ? env.RATE_LIMIT_AUTH_PER_MIN : env.RATE_LIMIT_API_PER_MIN;
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_LIMITS[bucket];
}

/** Counts one request against `key` and says whether it is within the limit. */
export async function hit(env: Env, bucket: Bucket, key: string): Promise<LimitResult> {
  if (env.RATE_LIMITS === 'off') return { ok: true };
  const binding = bucket === 'auth' ? env.AUTH_RATE_LIMITER : env.API_RATE_LIMITER;
  const fullKey = `${bucket}:${key}`;
  try {
    if (binding) {
      const { success } = await binding.limit({ key: fullKey });
      return success ? { ok: true } : { ok: false, retryAfter: WINDOW_MS / 1000 };
    }
    const now = Date.now();
    const windowStart = Math.floor(now / WINDOW_MS) * WINDOW_MS;
    const row = await env.DB.prepare(
      `INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
       ON CONFLICT (key, window_start) DO UPDATE SET count = count + 1
       RETURNING count`,
    )
      .bind(fullKey, windowStart)
      .first<{ count: number }>();
    if ((row?.count ?? 0) <= limitFor(env, bucket)) return { ok: true };
    return {
      ok: false,
      retryAfter: Math.max(1, Math.ceil((windowStart + WINDOW_MS - now) / 1000)),
    };
  } catch (err) {
    // Fail open: a limiter outage must not take sign-in or the API down with it.
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'ratelimit.error',
        bucket,
        message: err instanceof Error ? err.message.slice(0, 200) : 'unknown',
      }),
    );
    return { ok: true };
  }
}

export function tooManyRequests(retryAfter: number): HttpError {
  return new HttpError(
    429,
    'Too many requests',
    `Rate limit exceeded. Retry in ${retryAfter} seconds.`,
    {},
    { 'retry-after': String(retryAfter) },
  );
}

async function enforce(env: Env, bucket: Bucket, key: string): Promise<void> {
  const r = await hit(env, bucket, key);
  if (!r.ok) throw tooManyRequests(r.retryAfter);
}

async function hashed(value: string): Promise<string> {
  return (await sha256Hex(value)).slice(0, 32);
}

function clientIp(c: Context): string {
  return c.req.header('cf-connecting-ip') ?? 'unknown';
}

/** Per-IP limit on /api/v1/auth/*. */
export const authRateLimit: MiddlewareHandler<AppEnv> = async (c, next) => {
  await enforce(c.env, 'auth', `ip:${await hashed(clientIp(c))}`);
  await next();
};

/** Per-email limit, called by handlers once they have parsed an email from the body. */
export async function limitEmail(c: Context<AppEnv>, email: string): Promise<void> {
  await enforce(c.env, 'auth', `email:${await hashed(email.trim().toLowerCase())}`);
}

/** Per key / principal limit on /api/v1/* (auth routes excluded: they have their own) and /mcp. */
export const apiRateLimit: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.req.path.startsWith('/api/v1/auth/')) return next();
  const p = c.get('principal');
  const key = p
    ? p.keyId
      ? `key:${p.keyId}`
      : `user:${p.userId}`
    : `ip:${await hashed(clientIp(c))}`;
  await enforce(c.env, 'api', key);
  await next();
};

/** Drops finished windows (nightly). */
export async function pruneRateLimits(db: D1Database): Promise<void> {
  await db
    .prepare('DELETE FROM rate_limits WHERE window_start < ?')
    .bind(Date.now() - 60 * 60_000)
    .run();
}
