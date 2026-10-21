import { randomToken, sha256Hex } from '../lib/crypto';

/** Opaque web session tokens (ADR-0007): random cookie value, stored only as a SHA-256 hash. */

export const SESSION_COOKIE = 'sb_session';
export const SESSION_TTL_MS = 30 * 86_400_000;

export interface WebSessionRow {
  id_hash: string;
  user_id: string;
  created_at: number;
  expires_at: number;
  last_seen_at: number | null;
}

export async function createSession(
  db: D1Database,
  userId: string,
): Promise<{ token: string; expiresAt: number }> {
  const token = randomToken(43);
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;
  await db
    .prepare(
      'INSERT INTO web_sessions (id_hash, user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)',
    )
    .bind(await sha256Hex(token), userId, now, expiresAt, now)
    .run();
  return { token, expiresAt };
}

export async function verifySession(db: D1Database, token: string): Promise<WebSessionRow | null> {
  if (!/^[A-Za-z0-9]{20,100}$/.test(token)) return null;
  const row = await db
    .prepare('SELECT * FROM web_sessions WHERE id_hash = ?')
    .bind(await sha256Hex(token))
    .first<WebSessionRow>();
  if (!row || row.expires_at <= Date.now()) return null;
  return row;
}

export async function destroySession(db: D1Database, token: string): Promise<void> {
  await db
    .prepare('DELETE FROM web_sessions WHERE id_hash = ?')
    .bind(await sha256Hex(token))
    .run();
}

// ── Magic links ────────────────────────────────────────────────────────────
const LOGIN_TTL_MS = 15 * 60_000;

export async function createLoginToken(db: D1Database, email: string): Promise<string> {
  const token = randomToken(43);
  const now = Date.now();
  await db
    .prepare(
      'INSERT INTO login_tokens (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)',
    )
    .bind(await sha256Hex(token), email.trim().toLowerCase(), now, now + LOGIN_TTL_MS)
    .run();
  return token;
}

/** Consumes a magic-link token once. Returns the email it was issued for. */
export async function consumeLoginToken(db: D1Database, token: string): Promise<string | null> {
  if (!/^[A-Za-z0-9]{20,100}$/.test(token)) return null;
  const hash = await sha256Hex(token);
  const now = Date.now();
  const row = await db
    .prepare(
      'UPDATE login_tokens SET used_at = ?1 WHERE token_hash = ?2 AND used_at IS NULL AND expires_at > ?1 RETURNING email',
    )
    .bind(now, hash)
    .first<{ email: string }>();
  return row?.email ?? null;
}
