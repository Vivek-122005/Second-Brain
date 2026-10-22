import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Env } from '../env';
import { randomToken, sha256Hex, timingSafeEqual } from '../lib/crypto';
import { safeNext } from '../lib/redirect';
import { audit } from '../services/audit';
import { getUser, getUserByEmail, upsertUserByEmail, type UserRow } from '../services/spaces';
import { markEmailVerified, mayUseEmail, startSession } from './policy';
import type { AppEnv } from './principal';

/**
 * "Sign in with Google", implemented in-house (ADR-0007): OpenID Connect authorization code flow
 * with PKCE (S256), `state` and `nonce`.
 *
 * - The flow is bound to the browser by a random value in a short-lived HttpOnly cookie; the
 *   server keeps only its SHA-256 next to state, nonce and the PKCE verifier (single use, 10 min).
 * - The ID token's RS256 signature is checked against Google's JWKS (from the discovery
 *   document, both cached), and so are iss, aud/azp, exp, iat, nonce and email_verified.
 * - A Google identity links to an existing account with the same verified email, or creates one
 *   if the signup policy allows; the (provider, sub) pair is stored in `identities`.
 */

export const GOOGLE_DISCOVERY_URL = 'https://accounts.google.com/.well-known/openid-configuration';
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
export const OIDC_COOKIE = 'sb_oidc';
const COOKIE_PATH = '/api/v1/auth/google';
const FLOW_TTL_MS = 10 * 60_000;
const CACHE_TTL_MS = 60 * 60_000;
/** Allowed clock skew for exp/iat. */
const SKEW_S = 60;

interface DiscoveryDoc {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

interface Jwk extends JsonWebKey {
  kid?: string;
}

let discoveryCache: { doc: DiscoveryDoc; until: number } | null = null;
let jwksCache: { keys: Jwk[]; until: number; fetchedAt: number } | null = null;

/** Clears the discovery and JWKS caches (tests). */
export function resetOidcCache(): void {
  discoveryCache = null;
  jwksCache = null;
}

class OidcError extends Error {
  constructor(
    public readonly reason: string,
    public readonly outcome: 'failed' | 'not_allowed' | 'cancelled' = 'failed',
  ) {
    super(reason);
    this.name = 'OidcError';
  }
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new OidcError(`fetch ${new URL(url).host} ${res.status}`);
  return (await res.json()) as T;
}

async function discovery(): Promise<DiscoveryDoc> {
  if (discoveryCache && discoveryCache.until > Date.now()) return discoveryCache.doc;
  const doc = await getJson<DiscoveryDoc>(GOOGLE_DISCOVERY_URL);
  if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) {
    throw new OidcError('discovery document incomplete');
  }
  for (const u of [doc.authorization_endpoint, doc.token_endpoint, doc.jwks_uri]) {
    if (new URL(u).protocol !== 'https:') throw new OidcError('discovery endpoint not https');
  }
  discoveryCache = { doc, until: Date.now() + CACHE_TTL_MS };
  return doc;
}

async function signingKey(doc: DiscoveryDoc, kid: string): Promise<Jwk> {
  const now = Date.now();
  let key = jwksCache && jwksCache.until > now ? jwksCache.keys.find((k) => k.kid === kid) : null;
  // Unknown kid: Google may have rotated keys. Refetch, but at most once a minute.
  if (!key && (!jwksCache || jwksCache.until <= now || now - jwksCache.fetchedAt > 60_000)) {
    const { keys } = await getJson<{ keys: Jwk[] }>(doc.jwks_uri);
    jwksCache = { keys: keys ?? [], until: now + CACHE_TTL_MS, fetchedAt: now };
    key = jwksCache.keys.find((k) => k.kid === kid);
  }
  if (!key) throw new OidcError('unknown signing key');
  return key;
}

function b64urlBytes(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeJson(part: string): Record<string, unknown> {
  try {
    const v = JSON.parse(new TextDecoder().decode(b64urlBytes(part))) as unknown;
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new OidcError('malformed id_token');
}

export interface IdTokenClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  azp?: string;
  exp: number;
  iat: number;
  nonce?: string;
  email?: string;
  email_verified?: boolean | string;
  name?: string;
}

/** Verifies a Google ID token's signature and claims. Throws OidcError on any problem. */
export async function verifyIdToken(
  idToken: string,
  opts: { clientId: string; nonce: string; now?: number },
): Promise<IdTokenClaims & { email: string }> {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new OidcError('malformed id_token');
  const [h, p, sig] = parts as [string, string, string];
  const header = decodeJson(h);
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') {
    throw new OidcError('unsupported id_token alg');
  }
  const doc = await discovery();
  const jwk = await signingKey(doc, header.kid);
  if (jwk.kty !== 'RSA') throw new OidcError('unexpected key type');
  let ok = false;
  try {
    const key = await crypto.subtle.importKey(
      'jwk',
      { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    ok = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      key,
      b64urlBytes(sig),
      new TextEncoder().encode(`${h}.${p}`),
    );
  } catch {
    ok = false;
  }
  if (!ok) throw new OidcError('bad id_token signature');

  const c = decodeJson(p) as Partial<IdTokenClaims>;
  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  const issuers = new Set([doc.issuer, ...GOOGLE_ISSUERS]);
  if (typeof c.iss !== 'string' || !issuers.has(c.iss)) throw new OidcError('bad iss');
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!aud.includes(opts.clientId)) throw new OidcError('bad aud');
  if (aud.length > 1 && c.azp !== opts.clientId) throw new OidcError('bad azp');
  if (c.azp !== undefined && c.azp !== opts.clientId) throw new OidcError('bad azp');
  if (typeof c.exp !== 'number' || c.exp + SKEW_S < now) throw new OidcError('id_token expired');
  if (typeof c.iat !== 'number' || c.iat - SKEW_S > now) throw new OidcError('bad iat');
  if (typeof c.nonce !== 'string' || !timingSafeEqual(c.nonce, opts.nonce)) {
    throw new OidcError('bad nonce');
  }
  if (typeof c.sub !== 'string' || !c.sub) throw new OidcError('missing sub');
  if (typeof c.email !== 'string' || !c.email) throw new OidcError('missing email');
  if (c.email_verified !== true && c.email_verified !== 'true') {
    throw new OidcError('email not verified', 'not_allowed');
  }
  return c as IdTokenClaims & { email: string };
}

function redirectUri(c: Context<AppEnv>): string {
  return `${new URL(c.req.url).origin}${COOKIE_PATH}/callback`;
}

/** GET /api/v1/auth/google/start */
export async function googleStart(c: Context<AppEnv>): Promise<Response> {
  const env = c.env;
  const doc = await discovery();
  const flowId = randomToken(43);
  const state = randomToken(43);
  const nonce = randomToken(43);
  const verifier = randomToken(64);
  const challenge = b64url(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))),
  );
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO oidc_flows (id_hash, provider, state, nonce, code_verifier, redirect, created_at, expires_at)
     VALUES (?, 'google', ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      await sha256Hex(flowId),
      state,
      nonce,
      verifier,
      safeNext(c.req.query('redirect'), new URL(c.req.url).origin),
      now,
      now + FLOW_TTL_MS,
    )
    .run();
  setCookie(c, OIDC_COOKIE, flowId, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === 'https:',
    // Lax: the cookie must come back on Google's top-level redirect to the callback.
    sameSite: 'Lax',
    path: COOKIE_PATH,
    maxAge: Math.floor(FLOW_TTL_MS / 1000),
  });
  const url = new URL(doc.authorization_endpoint);
  url.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID ?? '',
    redirect_uri: redirectUri(c),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  }).toString();
  return c.redirect(url.toString(), 302);
}

interface FlowRow {
  state: string;
  nonce: string;
  code_verifier: string;
  redirect: string;
}

async function exchangeCode(
  env: Env,
  doc: DiscoveryDoc,
  code: string,
  verifier: string,
  redirect_uri: string,
): Promise<string> {
  const res = await fetch(doc.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri,
      client_id: env.GOOGLE_CLIENT_ID ?? '',
      client_secret: env.GOOGLE_CLIENT_SECRET ?? '',
    }).toString(),
  });
  if (!res.ok) throw new OidcError(`token endpoint ${res.status}`);
  const body = (await res.json()) as { id_token?: unknown };
  if (typeof body.id_token !== 'string') throw new OidcError('no id_token');
  return body.id_token;
}

/** Finds or creates the account for a verified Google identity. */
async function resolveUser(
  env: Env,
  claims: IdTokenClaims & { email: string },
): Promise<{ user: UserRow; linked: boolean; created: boolean }> {
  const db = env.DB;
  const identity = await db
    .prepare("SELECT user_id FROM identities WHERE provider = 'google' AND subject = ?")
    .bind(claims.sub)
    .first<{ user_id: string }>();
  if (identity) {
    const user = await getUser(db, identity.user_id);
    if (!user) throw new OidcError('identity user missing');
    if (!mayUseEmail(env, user.email)) throw new OidcError('not allowed', 'not_allowed');
    await db
      .prepare("UPDATE identities SET last_used_at = ? WHERE provider = 'google' AND subject = ?")
      .bind(Date.now(), claims.sub)
      .run();
    return { user, linked: false, created: false };
  }

  const email = claims.email.trim().toLowerCase();
  if (!mayUseEmail(env, email)) throw new OidcError('not allowed', 'not_allowed');
  const existing = await getUserByEmail(db, email);
  const user = existing ?? (await upsertUserByEmail(db, email));
  // Google has proven the email. This runs before the identity is stored because, on an
  // account nobody had verified yet, it revokes the credentials that existed before.
  await markEmailVerified(db, user.id, 'google');
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO identities (provider, subject, user_id, email, created_at, last_used_at)
       VALUES ('google', ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    )
    .bind(claims.sub, user.id, email, now, now)
    .run();
  return { user, linked: Boolean(existing), created: !existing };
}

/** GET /api/v1/auth/google/callback */
export async function googleCallback(c: Context<AppEnv>): Promise<Response> {
  const env = c.env;
  const flowId = getCookie(c, OIDC_COOKIE);
  deleteCookie(c, OIDC_COOKIE, { path: COOKIE_PATH });
  try {
    if (!flowId || !/^[A-Za-z0-9]{20,100}$/.test(flowId)) throw new OidcError('no flow cookie');
    const flow = await env.DB.prepare(
      `UPDATE oidc_flows SET used_at = ?1
       WHERE id_hash = ?2 AND provider = 'google' AND used_at IS NULL AND expires_at > ?1
       RETURNING state, nonce, code_verifier, redirect`,
    )
      .bind(Date.now(), await sha256Hex(flowId))
      .first<FlowRow>();
    if (!flow) throw new OidcError('unknown or expired flow');
    if (!timingSafeEqual(c.req.query('state') ?? '', flow.state)) {
      throw new OidcError('state mismatch');
    }
    if (c.req.query('error')) throw new OidcError('user cancelled', 'cancelled');
    const code = c.req.query('code');
    if (!code) throw new OidcError('no code');

    const doc = await discovery();
    const idToken = await exchangeCode(env, doc, code, flow.code_verifier, redirectUri(c));
    const claims = await verifyIdToken(idToken, {
      clientId: env.GOOGLE_CLIENT_ID ?? '',
      nonce: flow.nonce,
    });
    const { user, linked, created } = await resolveUser(env, claims);
    if (created) {
      await audit(env.DB, {
        spaceId: null,
        actorUserId: user.id,
        actorKeyId: null,
        action: 'auth.signup',
        target: user.id,
        metadata: { method: 'google' },
      });
    }
    if (linked || created) {
      await audit(env.DB, {
        spaceId: null,
        actorUserId: user.id,
        actorKeyId: null,
        action: 'auth.identity.link',
        target: user.id,
        metadata: { provider: 'google' },
      });
    }
    await startSession(c, user.id);
    await audit(env.DB, {
      spaceId: null,
      actorUserId: user.id,
      actorKeyId: null,
      action: 'auth.signin',
      target: user.id,
      metadata: { method: 'google' },
    });
    return c.redirect(flow.redirect, 302);
  } catch (err) {
    const reason = err instanceof OidcError ? err.reason : 'internal';
    const outcome = err instanceof OidcError ? err.outcome : 'failed';
    // Reason only: never the code, tokens or claims.
    console.error(
      JSON.stringify({
        level: 'warn',
        event: 'oidc.callback_failed',
        request_id: c.get('requestId'),
        reason,
      }),
    );
    await audit(env.DB, {
      spaceId: null,
      actorUserId: null,
      actorKeyId: null,
      action: 'auth.signin_failed',
      metadata: { method: 'google', reason },
    });
    return c.redirect(`/?signin=${outcome}`, 302);
  }
}

/** Drops old OIDC flow rows (nightly). */
export async function pruneOidcFlows(db: D1Database): Promise<void> {
  await db
    .prepare('DELETE FROM oidc_flows WHERE expires_at < ?')
    .bind(Date.now() - 86_400_000)
    .run();
}
