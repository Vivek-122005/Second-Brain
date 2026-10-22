import { ulid } from '@second-brain/core';
import type { KeyScope } from '@second-brain/schema';
import { parseScopes } from '../auth/keys';
import type { Principal } from '../auth/principal';
import type { Env } from '../env';
import { randomToken, sha256Hex, timingSafeEqual } from '../lib/crypto';
import { audit } from '../services/audit';
import { getUser, readableSpaces } from '../services/spaces';
import type { OAuthClientRow } from './clients';
import { OAuthError } from './errors';
import {
  ACCESS_TOKEN_PREFIX,
  ACCESS_TTL_MS,
  CODE_PREFIX,
  CODE_TTL_MS,
  mcpResource,
  REFRESH_TOKEN_PREFIX,
  REFRESH_TTL_MS,
  scopesJson,
} from './metadata';

/**
 * Grants, authorization codes and tokens (OAuth 2.1 §4.1, §4.3). Every secret is random (256 bits)
 * and stored only as a SHA-256 hash. State changes that must not race (consuming a code, rotating a
 * refresh token) run in one D1 batch whose later statements are guarded on the first one winning.
 */

export interface GrantRow {
  id: string;
  user_id: string;
  client_id: string;
  space_id: string;
  scopes: string;
  created_at: number;
  updated_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

interface CodeRow {
  code_hash: string;
  grant_id: string;
  client_id: string;
  user_id: string;
  redirect_uri: string;
  code_challenge: string;
  scopes: string;
  resource: string;
  family_id: string | null;
  created_at: number;
  expires_at: number;
  used_at: number | null;
}

interface TokenRow {
  token_hash: string;
  kind: 'access' | 'refresh';
  family_id: string;
  grant_id: string;
  client_id: string;
  user_id: string;
  scopes: string;
  resource: string;
  created_at: number;
  expires_at: number;
  used_at: number | null;
  replaced_by: string | null;
  revoked_at: number | null;
}

export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token?: string;
  scope: string;
}

// ── PKCE (RFC 7636, S256 only) ─────────────────────────────────────────────
const VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;
export const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;

function base64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

// ── Grants (the user's consent for one client) ─────────────────────────────
export async function upsertGrant(
  db: D1Database,
  input: { userId: string; clientId: string; spaceId: string; scopes: KeyScope[] },
): Promise<GrantRow> {
  const now = Date.now();
  const row = await db
    .prepare(
      `INSERT INTO oauth_grants (id, user_id, client_id, space_id, scopes, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
       ON CONFLICT (user_id, client_id) WHERE revoked_at IS NULL
       DO UPDATE SET space_id = excluded.space_id, scopes = excluded.scopes, updated_at = excluded.updated_at
       RETURNING *`,
    )
    .bind(
      `ogr_${ulid(now)}`,
      input.userId,
      input.clientId,
      input.spaceId,
      scopesJson(input.scopes),
      now,
    )
    .first<GrantRow>();
  if (!row) throw new Error('grant upsert failed');
  return row;
}

export async function createCode(
  db: D1Database,
  input: {
    grant: GrantRow;
    redirectUri: string;
    codeChallenge: string;
    scopes: KeyScope[];
    resource: string;
  },
): Promise<string> {
  const code = `${CODE_PREFIX}${randomToken(43)}`;
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO oauth_codes (code_hash, grant_id, client_id, user_id, redirect_uri, code_challenge, scopes,
                                resource, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      await sha256Hex(code),
      input.grant.id,
      input.grant.client_id,
      input.grant.user_id,
      input.redirectUri,
      input.codeChallenge,
      scopesJson(input.scopes),
      input.resource,
      now,
      now + CODE_TTL_MS,
    )
    .run();
  return code;
}

// ── Token minting ──────────────────────────────────────────────────────────
interface Minted {
  access: string;
  refresh: string | null;
  statements: D1PreparedStatement[];
}

/**
 * Builds the INSERTs for a new access (and refresh) token. `guard` is an SQL condition plus binds
 * that must hold for the rows to be written, so a lost race writes nothing.
 */
async function mint(
  db: D1Database,
  base: Pick<TokenRow, 'family_id' | 'grant_id' | 'client_id' | 'user_id' | 'scopes' | 'resource'>,
  withRefresh: boolean,
  guard: { sql: string; binds: unknown[] },
  refreshOverride?: { token: string; hash: string },
): Promise<Minted> {
  const now = Date.now();
  const access = `${ACCESS_TOKEN_PREFIX}${randomToken(43)}`;
  const refresh = withRefresh
    ? (refreshOverride?.token ?? `${REFRESH_TOKEN_PREFIX}${randomToken(43)}`)
    : null;
  const insert = (hash: string, kind: 'access' | 'refresh', ttl: number) =>
    db
      .prepare(
        `INSERT INTO oauth_tokens (token_hash, kind, family_id, grant_id, client_id, user_id, scopes, resource,
                                   created_at, expires_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard.sql}`,
      )
      .bind(
        hash,
        kind,
        base.family_id,
        base.grant_id,
        base.client_id,
        base.user_id,
        base.scopes,
        base.resource,
        now,
        now + ttl,
        ...guard.binds,
      );
  const statements = [insert(await sha256Hex(access), 'access', ACCESS_TTL_MS)];
  if (refresh) {
    const hash = refreshOverride?.hash ?? (await sha256Hex(refresh));
    statements.push(insert(hash, 'refresh', REFRESH_TTL_MS));
  }
  return { access, refresh, statements };
}

function response(m: Minted, scopes: string): TokenResponse {
  return {
    access_token: m.access,
    token_type: 'Bearer',
    expires_in: Math.floor(ACCESS_TTL_MS / 1000),
    ...(m.refresh ? { refresh_token: m.refresh } : {}),
    scope: parseScopes(scopes).join(' '),
  };
}

function allowsRefresh(client: OAuthClientRow): boolean {
  return (JSON.parse(client.grant_types) as string[]).includes('refresh_token');
}

async function activeGrant(db: D1Database, grantId: string): Promise<GrantRow | null> {
  return db
    .prepare('SELECT * FROM oauth_grants WHERE id = ? AND revoked_at IS NULL')
    .bind(grantId)
    .first<GrantRow>();
}

/** Revokes every token in a family. Used on code or refresh-token replay and on revocation. */
async function revokeFamily(db: D1Database, familyId: string): Promise<void> {
  await db
    .prepare('UPDATE oauth_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL')
    .bind(Date.now(), familyId)
    .run();
}

/** The audience a token request asks for. Only our /mcp endpoint is a valid target (RFC 8707). */
export function checkResource(origin: string, resource: string | undefined | null): string {
  const canonical = mcpResource(origin);
  if (!resource) return canonical;
  if (resource === canonical || resource === `${canonical}/`) return canonical;
  throw new OAuthError(400, 'invalid_target', `This server only issues tokens for ${canonical}.`);
}

// ── authorization_code grant ───────────────────────────────────────────────
export async function exchangeCode(
  env: Env,
  client: OAuthClientRow,
  form: Record<string, string>,
  origin: string,
): Promise<TokenResponse> {
  const db = env.DB;
  const code = form.code ?? '';
  const verifier = form.code_verifier ?? '';
  if (!code.startsWith(CODE_PREFIX)) throw new OAuthError(400, 'invalid_grant', 'Unknown code.');
  if (!VERIFIER_RE.test(verifier))
    throw new OAuthError(400, 'invalid_request', 'code_verifier is missing or malformed.');

  const codeHash = await sha256Hex(code);
  const row = await db
    .prepare('SELECT * FROM oauth_codes WHERE code_hash = ?')
    .bind(codeHash)
    .first<CodeRow>();
  if (!row || row.client_id !== client.id)
    throw new OAuthError(400, 'invalid_grant', 'Unknown code.');

  if (row.used_at !== null) {
    // A replayed code: revoke whatever it minted (OAuth 2.1 §4.1.3).
    if (row.family_id) await revokeFamily(db, row.family_id);
    await audit(db, {
      spaceId: null,
      actorUserId: row.user_id,
      actorKeyId: row.grant_id,
      action: 'oauth.code.reuse',
      target: row.grant_id,
      metadata: { client_id: client.id },
    });
    throw new OAuthError(400, 'invalid_grant', 'This code has already been used.');
  }
  if (row.expires_at <= Date.now())
    throw new OAuthError(400, 'invalid_grant', 'The code has expired.');
  if (form.redirect_uri !== undefined && form.redirect_uri !== row.redirect_uri)
    throw new OAuthError(
      400,
      'invalid_grant',
      'redirect_uri does not match the authorization request.',
    );
  if (checkResource(origin, form.resource) !== row.resource)
    throw new OAuthError(
      400,
      'invalid_target',
      'resource does not match the authorization request.',
    );
  if (!timingSafeEqual(await s256(verifier), row.code_challenge))
    throw new OAuthError(400, 'invalid_grant', 'PKCE verification failed.');

  const grant = await activeGrant(db, row.grant_id);
  if (!grant) throw new OAuthError(400, 'invalid_grant', 'The authorization has been revoked.');

  const familyId = `ofm_${ulid()}`;
  const now = Date.now();
  const consume = db
    .prepare(
      'UPDATE oauth_codes SET used_at = ?, family_id = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?',
    )
    .bind(now, familyId, codeHash, now);
  const minted = await mint(
    db,
    {
      family_id: familyId,
      grant_id: grant.id,
      client_id: client.id,
      user_id: row.user_id,
      scopes: row.scopes,
      resource: row.resource,
    },
    allowsRefresh(client),
    {
      sql: 'EXISTS (SELECT 1 FROM oauth_codes WHERE code_hash = ? AND family_id = ?)',
      binds: [codeHash, familyId],
    },
  );
  const results = await db.batch([consume, ...minted.statements]);
  if (results[0]?.meta.changes !== 1)
    throw new OAuthError(400, 'invalid_grant', 'This code has already been used.');

  await audit(db, {
    spaceId: null,
    actorUserId: row.user_id,
    actorKeyId: grant.id,
    action: 'oauth.token.issue',
    target: grant.id,
    metadata: { client_id: client.id, family_id: familyId, scopes: parseScopes(row.scopes) },
  });
  return response(minted, row.scopes);
}

// ── refresh_token grant (rotation with reuse detection) ────────────────────
export async function refreshTokens(
  env: Env,
  client: OAuthClientRow,
  form: Record<string, string>,
  origin: string,
): Promise<TokenResponse> {
  const db = env.DB;
  const token = form.refresh_token ?? '';
  if (!token.startsWith(REFRESH_TOKEN_PREFIX))
    throw new OAuthError(400, 'invalid_grant', 'Unknown refresh token.');
  const hash = await sha256Hex(token);
  const row = await db
    .prepare("SELECT * FROM oauth_tokens WHERE token_hash = ? AND kind = 'refresh'")
    .bind(hash)
    .first<TokenRow>();
  if (!row || row.client_id !== client.id)
    throw new OAuthError(400, 'invalid_grant', 'Unknown refresh token.');
  if (row.revoked_at !== null)
    throw new OAuthError(400, 'invalid_grant', 'The refresh token has been revoked.');

  const reuse = async () => {
    await revokeFamily(db, row.family_id);
    await audit(db, {
      spaceId: null,
      actorUserId: row.user_id,
      actorKeyId: row.grant_id,
      action: 'oauth.refresh.reuse',
      target: row.grant_id,
      metadata: { client_id: client.id, family_id: row.family_id },
    });
    return new OAuthError(400, 'invalid_grant', 'This refresh token has already been used.');
  };
  if (row.used_at !== null) throw await reuse();
  if (row.expires_at <= Date.now())
    throw new OAuthError(400, 'invalid_grant', 'The refresh token has expired.');
  if (checkResource(origin, form.resource) !== row.resource)
    throw new OAuthError(400, 'invalid_target', 'resource does not match the original grant.');

  const grant = await activeGrant(db, row.grant_id);
  if (!grant) throw new OAuthError(400, 'invalid_grant', 'The authorization has been revoked.');

  // A refresh may narrow the scopes but never widen them (RFC 6749 §6).
  let scopes = row.scopes;
  if (form.scope) {
    const had = parseScopes(row.scopes);
    const asked = form.scope.split(/\s+/).filter(Boolean);
    if (asked.some((s) => !had.includes(s as KeyScope)))
      throw new OAuthError(400, 'invalid_scope', 'A refresh cannot add scopes.');
    scopes = scopesJson(asked as KeyScope[]);
  }

  const next = `${REFRESH_TOKEN_PREFIX}${randomToken(43)}`;
  const nextHash = await sha256Hex(next);
  const now = Date.now();
  const rotate = db
    .prepare(
      `UPDATE oauth_tokens SET used_at = ?, replaced_by = ?
       WHERE token_hash = ? AND used_at IS NULL AND revoked_at IS NULL`,
    )
    .bind(now, nextHash, hash);
  const minted = await mint(
    db,
    {
      family_id: row.family_id,
      grant_id: row.grant_id,
      client_id: client.id,
      user_id: row.user_id,
      scopes,
      resource: row.resource,
    },
    true,
    {
      sql: 'EXISTS (SELECT 1 FROM oauth_tokens WHERE token_hash = ? AND replaced_by = ?)',
      binds: [hash, nextHash],
    },
    { token: next, hash: nextHash },
  );
  const results = await db.batch([rotate, ...minted.statements]);
  // Lost a race with another refresh of the same token: that is a replay too.
  if (results[0]?.meta.changes !== 1) throw await reuse();

  await audit(db, {
    spaceId: null,
    actorUserId: row.user_id,
    actorKeyId: row.grant_id,
    action: 'oauth.token.refresh',
    target: row.grant_id,
    metadata: { client_id: client.id, family_id: row.family_id },
  });
  return response(minted, scopes);
}

// ── Revocation (RFC 7009) ──────────────────────────────────────────────────
/**
 * Revokes an access or refresh token. Revoking a refresh token revokes its whole family. Unknown
 * tokens and tokens of other clients are ignored, and the endpoint answers 200 either way.
 */
export async function revokeToken(
  db: D1Database,
  client: OAuthClientRow | null,
  token: string,
): Promise<void> {
  if (!token.startsWith(ACCESS_TOKEN_PREFIX) && !token.startsWith(REFRESH_TOKEN_PREFIX)) return;
  const row = await db
    .prepare('SELECT * FROM oauth_tokens WHERE token_hash = ?')
    .bind(await sha256Hex(token))
    .first<TokenRow>();
  if (!row || row.revoked_at !== null) return;
  if (client && client.id !== row.client_id) return;
  if (row.kind === 'refresh') await revokeFamily(db, row.family_id);
  else
    await db
      .prepare('UPDATE oauth_tokens SET revoked_at = ? WHERE token_hash = ?')
      .bind(Date.now(), row.token_hash)
      .run();
  await audit(db, {
    spaceId: null,
    actorUserId: row.user_id,
    actorKeyId: row.grant_id,
    action: 'oauth.token.revoke',
    target: row.grant_id,
    metadata: { client_id: row.client_id, kind: row.kind },
  });
}

// ── Access tokens → Principal ──────────────────────────────────────────────
interface AccessLookup extends TokenRow {
  space_id: string;
  grant_scopes: string;
  grant_last_used_at: number | null;
  client_name: string;
}

/**
 * Resolves an OAuth access token to a Principal. Tokens are audience-bound to `<origin>/mcp`, so
 * they only work on the MCP endpoint, never on the REST API.
 */
export async function principalFromAccessToken(
  env: Env,
  token: string,
  requestUrl: string,
  ctx: ExecutionContext | undefined,
): Promise<Principal | null> {
  const url = new URL(requestUrl);
  if (url.pathname !== '/mcp' && !url.pathname.startsWith('/mcp/')) return null;
  if (!/^sb_oat_[A-Za-z0-9]{43}$/.test(token)) return null;
  const row = await env.DB.prepare(
    `SELECT t.*, g.space_id, g.scopes AS grant_scopes, g.last_used_at AS grant_last_used_at,
            c.name AS client_name
     FROM oauth_tokens t
     JOIN oauth_grants g ON g.id = t.grant_id AND g.revoked_at IS NULL
     JOIN oauth_clients c ON c.id = t.client_id
     WHERE t.token_hash = ? AND t.kind = 'access'`,
  )
    .bind(await sha256Hex(token))
    .first<AccessLookup>();
  const now = Date.now();
  if (!row || row.revoked_at !== null || row.expires_at <= now) return null;
  if (row.resource !== mcpResource(url.origin)) return null;

  const user = await getUser(env.DB, row.user_id);
  if (!user) return null;
  const spaces = (await readableSpaces(env.DB, user.id)).filter((s) => s.id === row.space_id);
  const defaultSpace = spaces[0];
  if (!defaultSpace) return null;

  // Scopes are what the token carries, narrowed by any later change to the grant.
  const grantScopes = parseScopes(row.grant_scopes);
  const scopes = parseScopes(row.scopes).filter((s) => grantScopes.includes(s));

  if (!row.grant_last_used_at || now - row.grant_last_used_at > 300_000) {
    const touch = env.DB.prepare('UPDATE oauth_grants SET last_used_at = ? WHERE id = ?')
      .bind(now, row.grant_id)
      .run();
    if (ctx) ctx.waitUntil(touch);
    else await touch;
  }

  return {
    userId: user.id,
    email: user.email,
    name: user.name,
    via: 'oauth',
    keyId: row.grant_id,
    keyPrefix: null,
    client: row.client_name,
    machine: null,
    scopes,
    spaces,
    defaultSpace,
    project: null,
  };
}

/** Deletes expired codes and tokens. Runs from the nightly Cron. */
export async function purgeExpiredOAuth(db: D1Database): Promise<void> {
  const cutoff = Date.now() - 86_400_000;
  await db.batch([
    db.prepare('DELETE FROM oauth_codes WHERE expires_at < ?').bind(cutoff),
    db.prepare('DELETE FROM oauth_tokens WHERE expires_at < ?').bind(cutoff),
  ]);
}
