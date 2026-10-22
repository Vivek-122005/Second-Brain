import { ulid } from '@second-brain/core';
import type { Passkey } from '@second-brain/schema';
import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import { csv, type Env, isDev } from '../env';
import { HttpError } from '../lib/http';
import { createUser, getUser, getUserByEmail, type UserRow } from '../services/spaces';
import { googleEnabled, magicLinkEnabled, mayUseEmail } from './policy';

/**
 * Passkeys (WebAuthn) via @simplewebauthn/server (ADR-0007).
 *
 * - Challenges are 32 random bytes, stored server-side, single-use and valid for 5 minutes.
 *   They are found by the challenge the browser echoes back in clientDataJSON and consumed with
 *   a conditional UPDATE before verification, so a replayed response always fails.
 * - Credentials are discoverable (resident keys) and need user verification, so users can sign
 *   in without typing an email.
 * - The WebAuthn user handle is our user id (opaque, no personal data).
 * - We own the signature-counter check: a counter that does not increase (when the
 *   authenticator keeps one) means a cloned authenticator, and the sign-in is refused.
 */

export const CHALLENGE_TTL_MS = 5 * 60_000;
const DEFAULT_NAME = 'Passkey';

export interface PasskeyRow {
  id: string;
  user_id: string;
  credential_id: string;
  public_key: string;
  counter: number;
  transports: string;
  device_type: 'singleDevice' | 'multiDevice';
  backed_up: number;
  aaguid: string | null;
  name: string;
  created_at: number;
  last_used_at: number | null;
}

interface ChallengeRow {
  challenge: string;
  kind: 'register' | 'login';
  user_id: string | null;
  email: string | null;
  new_user_id: string | null;
  name: string | null;
  created_at: number;
  expires_at: number;
  used_at: number | null;
}

export interface RelyingParty {
  rpID: string;
  rpName: string;
  /** Origins whose clientDataJSON we accept. */
  origins: string[];
}

/** A passkey failure: problem+json with `verified: false`, as the web app expects. */
function fail(status: 400 | 401 | 403 | 409, title: string, detail: string): HttpError {
  return new HttpError(status, title, detail, { verified: false });
}

export function passkeysEnabled(env: Env): boolean {
  return Boolean(env.WEBAUTHN_RP_ID) || isDev(env);
}

/** RP ID and name from env; in development the RP ID falls back to the request's host. */
export function relyingParty(env: Env, requestUrl: string): RelyingParty {
  const self = new URL(requestUrl);
  const rpID = env.WEBAUTHN_RP_ID || (isDev(env) ? self.hostname : '');
  if (!rpID) {
    throw new HttpError(
      503,
      'Passkeys not configured',
      'Set WEBAUTHN_RP_ID on this server to enable passkeys.',
    );
  }
  const origins = [...new Set([self.origin, ...csv(env.APP_ORIGINS)])].filter((o) => {
    try {
      const host = new URL(o).hostname;
      return host === rpID || host.endsWith(`.${rpID}`);
    } catch {
      return false;
    }
  });
  return { rpID, rpName: env.WEBAUTHN_RP_NAME || 'Second Brain', origins };
}

function newChallenge(): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytes;
}

async function storeChallenge(
  db: D1Database,
  row: Omit<ChallengeRow, 'created_at' | 'expires_at' | 'used_at'>,
): Promise<void> {
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO webauthn_challenges (challenge, kind, user_id, email, new_user_id, name, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.challenge,
      row.kind,
      row.user_id,
      row.email,
      row.new_user_id,
      row.name,
      now,
      now + CHALLENGE_TTL_MS,
    )
    .run();
}

/** Reads the challenge out of clientDataJSON without trusting anything else in it. */
function echoedChallenge(clientDataJSON: string): string {
  try {
    const data = JSON.parse(isoBase64URL.toUTF8String(clientDataJSON)) as { challenge?: unknown };
    if (typeof data.challenge === 'string' && data.challenge.length > 0) return data.challenge;
  } catch {
    // fall through
  }
  throw fail(400, 'Invalid passkey response', 'The passkey response could not be read.');
}

/** Atomically marks the challenge used. Returns null if unknown, expired, used or of another kind. */
async function consumeChallenge(
  db: D1Database,
  challenge: string,
  kind: ChallengeRow['kind'],
): Promise<ChallengeRow | null> {
  return db
    .prepare(
      `UPDATE webauthn_challenges SET used_at = ?1
       WHERE challenge = ?2 AND kind = ?3 AND used_at IS NULL AND expires_at > ?1
       RETURNING *`,
    )
    .bind(Date.now(), challenge, kind)
    .first<ChallengeRow>();
}

const expired = () =>
  fail(400, 'Passkey request expired', 'That passkey request has expired. Please try again.');

function userHandle(userId: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new TextEncoder().encode(userId));
}

export function toPasskey(r: PasskeyRow): Passkey {
  return {
    id: r.id,
    name: r.name,
    created_at: new Date(r.created_at).toISOString(),
    last_used_at: r.last_used_at ? new Date(r.last_used_at).toISOString() : null,
    transports: JSON.parse(r.transports) as string[],
    device_type: r.device_type,
    backed_up: r.backed_up === 1,
  };
}

export async function listPasskeys(db: D1Database, userId: string): Promise<PasskeyRow[]> {
  const r = await db
    .prepare('SELECT * FROM passkeys WHERE user_id = ? ORDER BY created_at, rowid')
    .bind(userId)
    .all<PasskeyRow>();
  return r.results;
}

// ── Registration ───────────────────────────────────────────────────────────

export type RegistrationSubject =
  { kind: 'existing'; user: UserRow } | { kind: 'signup'; email: string };

export async function registrationOptions(
  env: Env,
  requestUrl: string,
  subject: RegistrationSubject,
  name: string | undefined,
): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const rp = relyingParty(env, requestUrl);
  let userId: string;
  let email: string;
  let exclude: { id: string; transports?: string[] }[] = [];
  if (subject.kind === 'existing') {
    userId = subject.user.id;
    email = subject.user.email;
    exclude = (await listPasskeys(env.DB, userId)).map((p) => ({
      id: p.credential_id,
      transports: JSON.parse(p.transports) as string[],
    }));
  } else {
    email = subject.email.trim().toLowerCase();
    if (!mayUseEmail(env, email)) {
      throw fail(403, 'Sign-up not allowed', 'This email cannot sign up on this server.');
    }
    if (await getUserByEmail(env.DB, email)) {
      throw fail(
        409,
        'Account exists',
        'An account with this email already exists. Sign in, then add a passkey in Settings.',
      );
    }
    userId = `usr_${ulid()}`;
  }

  const options = await generateRegistrationOptions({
    rpName: rp.rpName,
    rpID: rp.rpID,
    userName: email,
    userID: userHandle(userId),
    userDisplayName: subject.kind === 'existing' ? (subject.user.name ?? email) : email,
    challenge: newChallenge(),
    timeout: CHALLENGE_TTL_MS,
    attestationType: 'none',
    excludeCredentials: exclude,
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  });
  await storeChallenge(env.DB, {
    challenge: options.challenge,
    kind: 'register',
    user_id: subject.kind === 'existing' ? userId : null,
    email: subject.kind === 'signup' ? email : null,
    new_user_id: subject.kind === 'signup' ? userId : null,
    name: name ?? null,
  });
  return options;
}

export interface RegistrationResult {
  passkey: PasskeyRow;
  user: UserRow;
  /** True when this registration created the account. */
  created: boolean;
}

/**
 * Verifies a registration response. `currentUserId` is the signed-in user (session), or null.
 * A challenge issued to a signed-in user can only be completed by that same user.
 */
export async function verifyRegistration(
  env: Env,
  requestUrl: string,
  response: RegistrationResponseJSON,
  currentUserId: string | null,
  name: string | undefined,
): Promise<RegistrationResult> {
  const rp = relyingParty(env, requestUrl);
  const row = await consumeChallenge(
    env.DB,
    echoedChallenge(response.response.clientDataJSON),
    'register',
  );
  if (!row) throw expired();
  if (row.user_id && row.user_id !== currentUserId) {
    throw fail(403, 'Forbidden', 'This passkey request belongs to another session.');
  }

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: row.challenge,
      expectedOrigin: rp.origins,
      expectedRPID: rp.rpID,
      requireUserVerification: true,
    });
  } catch {
    throw fail(400, 'Invalid passkey response', 'The passkey could not be verified.');
  }
  if (!verification.verified) {
    throw fail(400, 'Invalid passkey response', 'The passkey could not be verified.');
  }
  const info = verification.registrationInfo;
  const credentialId = info.credential.id;
  const taken = await env.DB.prepare('SELECT 1 FROM passkeys WHERE credential_id = ?')
    .bind(credentialId)
    .first();
  if (taken) throw fail(409, 'Passkey exists', 'This passkey is already registered.');

  let user: UserRow | null;
  let created = false;
  if (row.user_id) {
    user = await getUser(env.DB, row.user_id);
    if (!user) throw expired();
  } else {
    const email = row.email ?? '';
    // Re-check the policy: the allow-list may have changed in the last five minutes.
    if (!row.new_user_id || !mayUseEmail(env, email)) {
      throw fail(403, 'Sign-up not allowed', 'This email cannot sign up on this server.');
    }
    user = await createUser(env.DB, row.new_user_id, email);
    if (!user) {
      throw fail(409, 'Account exists', 'An account with this email already exists. Sign in.');
    }
    created = true;
  }

  const now = Date.now();
  const passkey: PasskeyRow = {
    id: `pky_${ulid(now)}`,
    user_id: user.id,
    credential_id: credentialId,
    public_key: isoBase64URL.fromBuffer(info.credential.publicKey),
    counter: info.credential.counter,
    transports: JSON.stringify(info.credential.transports ?? response.response.transports ?? []),
    device_type: info.credentialDeviceType,
    backed_up: info.credentialBackedUp ? 1 : 0,
    aaguid: info.aaguid,
    name: name ?? row.name ?? DEFAULT_NAME,
    created_at: now,
    last_used_at: null,
  };
  const inserted = await env.DB.prepare(
    `INSERT INTO passkeys (id, user_id, credential_id, public_key, counter, transports, device_type, backed_up, aaguid, name, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (credential_id) DO NOTHING RETURNING id`,
  )
    .bind(
      passkey.id,
      passkey.user_id,
      passkey.credential_id,
      passkey.public_key,
      passkey.counter,
      passkey.transports,
      passkey.device_type,
      passkey.backed_up,
      passkey.aaguid,
      passkey.name,
      passkey.created_at,
    )
    .first();
  if (!inserted) throw fail(409, 'Passkey exists', 'This passkey is already registered.');
  return { passkey, user, created };
}

// ── Authentication ─────────────────────────────────────────────────────────

export async function authenticationOptions(
  env: Env,
  requestUrl: string,
): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const rp = relyingParty(env, requestUrl);
  const options = await generateAuthenticationOptions({
    rpID: rp.rpID,
    challenge: newChallenge(),
    timeout: CHALLENGE_TTL_MS,
    userVerification: 'required',
    // No allow-list: discoverable credentials, and nothing to reveal about who has passkeys.
    allowCredentials: [],
  });
  await storeChallenge(env.DB, {
    challenge: options.challenge,
    kind: 'login',
    user_id: null,
    email: null,
    new_user_id: null,
    name: null,
  });
  return options;
}

export interface AuthenticationResult {
  user: UserRow;
  passkey: PasskeyRow;
}

/**
 * The counter rule (WebAuthn §6.1.1): when either side has a non-zero counter, the new value
 * must be strictly greater than the stored one. Authenticators without a counter always send 0.
 */
export function counterIsValid(stored: number, received: number): boolean {
  if (stored === 0 && received === 0) return true;
  return received > stored;
}

export async function verifyAuthentication(
  env: Env,
  requestUrl: string,
  response: AuthenticationResponseJSON,
): Promise<AuthenticationResult> {
  const rp = relyingParty(env, requestUrl);
  const row = await consumeChallenge(
    env.DB,
    echoedChallenge(response.response.clientDataJSON),
    'login',
  );
  if (!row) throw expired();

  const unknown = () =>
    fail(401, 'Passkey not recognised', 'This passkey is not registered on this server.');
  const passkey = await env.DB.prepare('SELECT * FROM passkeys WHERE credential_id = ?')
    .bind(response.id)
    .first<PasskeyRow>();
  if (!passkey) throw unknown();
  if (response.response.userHandle) {
    let handle = '';
    try {
      handle = isoBase64URL.toUTF8String(response.response.userHandle);
    } catch {
      throw unknown();
    }
    if (handle !== passkey.user_id) throw unknown();
  }
  const user = await getUser(env.DB, passkey.user_id);
  if (!user) throw unknown();

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: row.challenge,
      expectedOrigin: rp.origins,
      expectedRPID: rp.rpID,
      // The counter check is ours (below), so the library sees a zero counter.
      credential: {
        id: passkey.credential_id,
        publicKey: isoBase64URL.toBuffer(passkey.public_key),
        counter: 0,
        transports: JSON.parse(passkey.transports) as string[],
      },
      requireUserVerification: true,
    });
  } catch {
    throw fail(401, 'Passkey rejected', 'The passkey signature could not be verified.');
  }
  if (!verification.verified) {
    throw fail(401, 'Passkey rejected', 'The passkey signature could not be verified.');
  }

  const received = verification.authenticationInfo.newCounter;
  if (!counterIsValid(passkey.counter, received)) {
    throw new CounterRegressionError(passkey, received);
  }
  // Compare-and-swap so two concurrent assertions with the same counter can't both succeed.
  const now = Date.now();
  const updated = await env.DB.prepare(
    'UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ? AND counter = ? RETURNING id',
  )
    .bind(received, now, passkey.id, passkey.counter)
    .first();
  if (!updated) throw new CounterRegressionError(passkey, received);
  return { user, passkey: { ...passkey, counter: received, last_used_at: now } };
}

/** A possibly cloned authenticator. The route audits it before answering 401. */
export class CounterRegressionError extends HttpError {
  constructor(
    public readonly passkey: PasskeyRow,
    public readonly received: number,
  ) {
    super(401, 'Passkey rejected', 'This passkey looks cloned. Sign in another way.', {
      verified: false,
    });
  }
}

// ── Management ─────────────────────────────────────────────────────────────

export async function renamePasskey(
  db: D1Database,
  userId: string,
  id: string,
  name: string,
): Promise<PasskeyRow | null> {
  return db
    .prepare('UPDATE passkeys SET name = ? WHERE id = ? AND user_id = ? RETURNING *')
    .bind(name, id, userId)
    .first<PasskeyRow>();
}

export async function getPasskey(
  db: D1Database,
  userId: string,
  id: string,
): Promise<PasskeyRow | null> {
  return db
    .prepare('SELECT * FROM passkeys WHERE id = ? AND user_id = ?')
    .bind(id, userId)
    .first<PasskeyRow>();
}

/**
 * Deletes a passkey unless it is the user's last way to sign in. The check and the delete are one
 * statement, so two concurrent deletes can't remove the last two passkeys together.
 * Returns false when nothing was deleted (not found, or it was the last method).
 */
export async function deletePasskeyUnlessLast(
  env: Env,
  userId: string,
  id: string,
): Promise<boolean> {
  const r = await env.DB.prepare(
    `DELETE FROM passkeys WHERE id = ?1 AND user_id = ?2 AND (
       ?3 = 1
       OR EXISTS (SELECT 1 FROM passkeys o WHERE o.user_id = ?2 AND o.id != ?1)
       OR (?4 = 1 AND EXISTS (SELECT 1 FROM identities i WHERE i.user_id = ?2))
     )`,
  )
    .bind(id, userId, magicLinkEnabled(env) ? 1 : 0, googleEnabled(env) ? 1 : 0)
    .run();
  return r.meta.changes > 0;
}

/** Drops expired challenges (nightly). */
export async function pruneChallenges(db: D1Database): Promise<void> {
  await db
    .prepare('DELETE FROM webauthn_challenges WHERE expires_at < ?')
    .bind(Date.now() - 86_400_000)
    .run();
}
