import type { Context } from 'hono';
import { setCookie } from 'hono/cookie';
import { csv, type Env, isDev } from '../env';
import { audit } from '../services/audit';
import { attachPendingGrants } from '../services/spaces';
import type { AppEnv } from './principal';
import { createSession, SESSION_COOKIE, SESSION_TTL_MS } from './sessions';

/** Sign-in policy shared by every method (magic link, passkeys, Google). */

/** SIGNUP_MODE / ALLOWED_EMAILS: `open` lets anyone in, `allowlist` only the listed emails. */
export function mayUseEmail(env: Env, email: string): boolean {
  if (env.SIGNUP_MODE === 'open') return true;
  return csv(env.ALLOWED_EMAILS)
    .map((e) => e.toLowerCase())
    .includes(email.trim().toLowerCase());
}

/** Magic links work when an email provider is configured, or in local development. */
export function magicLinkEnabled(env: Env): boolean {
  return Boolean(env.RESEND_API_KEY) || isDev(env);
}

export function googleEnabled(env: Env): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}

/** Creates a web session for the user and sets the session cookie. */
export async function startSession(c: Context<AppEnv>, userId: string): Promise<void> {
  const session = await createSession(c.env.DB, userId);
  setCookie(c, SESSION_COOKIE, session.token, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === 'https:',
    sameSite: 'Lax',
    path: '/',
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

/**
 * Records that the user has just proven they own their email (magic link or a verified Google
 * email).
 *
 * Accounts created by passkey sign-up start unverified: anyone could have typed that address.
 * To stop account pre-hijacking (an attacker signs up as victim@example.com with their own
 * passkey and waits for the real owner to sign in by email), the first email proof on such an
 * account revokes every credential that existed before it: passkeys, linked identities, web
 * sessions and API keys. The real owner then adds their own passkey again.
 */
export async function markEmailVerified(
  db: D1Database,
  userId: string,
  via: 'magic_link' | 'google',
): Promise<void> {
  const now = Date.now();
  const updated = await db
    .prepare(
      'UPDATE users SET email_verified_at = ? WHERE id = ? AND email_verified_at IS NULL RETURNING id',
    )
    .bind(now, userId)
    .first<{ id: string }>();
  // The email is proven now, so invitations addressed to it may attach to this account.
  const owner = await db
    .prepare('SELECT email FROM users WHERE id = ?')
    .bind(userId)
    .first<{ email: string }>();
  if (owner) await attachPendingGrants(db, owner.email);
  if (!updated) return; // already verified
  const [pk, ids, sessions, keys] = await db.batch([
    db.prepare('DELETE FROM passkeys WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM identities WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM web_sessions WHERE user_id = ?').bind(userId),
    db
      .prepare('UPDATE api_keys SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
      .bind(now, userId),
  ]);
  const counts = {
    passkeys: pk?.meta.changes ?? 0,
    identities: ids?.meta.changes ?? 0,
    sessions: sessions?.meta.changes ?? 0,
    keys: keys?.meta.changes ?? 0,
  };
  await audit(db, {
    spaceId: null,
    actorUserId: userId,
    actorKeyId: null,
    action: 'auth.email_verified',
    target: userId,
    metadata: { via, revoked: counts },
  });
}
