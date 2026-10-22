import {
  type AuthProvidersResponse,
  DeviceApproveRequest,
  DeviceStartRequest,
  type DeviceStartResponse,
  DeviceTokenRequest,
  type DeviceTokenResponse,
  MagicLinkRequest,
  type MagicLinkResponse,
  type Page,
  type Passkey,
  PasskeyLoginOptionsRequest,
  PasskeyRegisterOptionsRequest,
  PasskeyVerifyRequest,
  type PasskeyVerifyResponse,
  RenamePasskeyRequest,
} from '@second-brain/schema';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { type Context, Hono } from 'hono';
import { deleteCookie, getCookie } from 'hono/cookie';
import { createKey } from '../auth/keys';
import {
  decideDevice,
  DEVICE_INTERVAL_S,
  getPendingByUserCode,
  pollDevice,
  startDevice,
  toDeviceInfo,
} from '../auth/device';
import { googleCallback, googleStart } from '../auth/oidc';
import {
  authenticationOptions,
  CounterRegressionError,
  deletePasskeyUnlessLast,
  getPasskey,
  listPasskeys,
  passkeysEnabled,
  registrationOptions,
  renamePasskey,
  toPasskey,
  verifyAuthentication,
  verifyRegistration,
} from '../auth/passkeys';
import {
  googleEnabled,
  magicLinkEnabled,
  markEmailVerified,
  mayUseEmail,
  startSession,
} from '../auth/policy';
import { type AppEnv, type Principal, requirePrincipal } from '../auth/principal';
import {
  consumeLoginToken,
  createLoginToken,
  destroySession,
  SESSION_COOKIE,
} from '../auth/sessions';
import { csv, isDev } from '../env';
import { badRequest, conflict, forbidden, HttpError, notFound, parse, readJson } from '../lib/http';
import { limitEmail } from '../lib/ratelimit';
import { safeNext } from '../lib/redirect';
import { audit } from '../services/audit';
import { sendMagicLink } from '../services/mail';
import { getUser, upsertUserByEmail } from '../services/spaces';

export const authRoutes = new Hono<AppEnv>();

/** JSON body, or `{}` when the body is empty. */
async function readOptionalJson(c: Context): Promise<unknown> {
  const text = await c.req.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw badRequest('Body must be valid JSON.');
  }
}

/**
 * Passkey endpoints can set a session cookie without one being sent, so the cookie-based CSRF
 * check in `identify` doesn't cover them. Require our own Origin on every passkey POST (stops
 * login CSRF: a foreign page signing the browser in to someone else's account).
 */
function requireOwnOrigin(c: Context<AppEnv>): void {
  const origin = c.req.header('origin');
  const allowed = new Set([new URL(c.req.url).origin, ...csv(c.env.APP_ORIGINS)]);
  if (!origin || !allowed.has(origin)) {
    throw new HttpError(403, 'Forbidden', 'Cross-origin passkey requests are not allowed.', {
      verified: false,
    });
  }
}

/** Sign-in methods are managed from the web app (session), never with an API key. */
function requireSession(c: Context<AppEnv>): Principal {
  const p = requirePrincipal(c);
  if (p.via !== 'session') throw forbidden('Manage sign-in methods from the web app.');
  return p;
}

function requirePasskeys(c: Context<AppEnv>): void {
  if (!passkeysEnabled(c.env)) {
    throw new HttpError(
      503,
      'Passkeys not configured',
      'Set WEBAUTHN_RP_ID on this server to enable passkeys.',
    );
  }
}

authRoutes.get('/providers', (c) => {
  const body: AuthProvidersResponse = {
    passkey: passkeysEnabled(c.env),
    google: googleEnabled(c.env),
    magic_link: magicLinkEnabled(c.env),
  };
  return c.json(body);
});

authRoutes.post('/magic-link', async (c) => {
  const { email, next } = parse(MagicLinkRequest, await readJson(c));
  await limitEmail(c, email);
  const origin = new URL(c.req.url).origin;
  const body: MagicLinkResponse = { sent: true };
  // Same response whether or not the email is allowed, so the endpoint can't be used to probe.
  if (!mayUseEmail(c.env, email)) return c.json(body, 202);

  const token = await createLoginToken(c.env.DB, email, next ? safeNext(next, origin) : null);
  const link = `${origin}/api/v1/auth/verify?token=${token}`;
  if (c.env.RESEND_API_KEY) {
    await sendMagicLink(c.env, email, link);
  } else if (isDev(c.env)) {
    body.dev_link = link;
  } else {
    throw new HttpError(
      503,
      'Email not configured',
      'Sign-in emails are not configured on this server yet.',
    );
  }
  return c.json(body, 202);
});

authRoutes.get('/verify', async (c) => {
  const token = c.req.query('token') ?? '';
  const login = await consumeLoginToken(c.env.DB, token);
  if (!login) return c.redirect('/?signin=expired', 302);
  const user = await upsertUserByEmail(c.env.DB, login.email);
  await markEmailVerified(c.env.DB, user.id, 'magic_link');
  await startSession(c, user.id);
  await audit(c.env.DB, {
    spaceId: null,
    actorUserId: user.id,
    actorKeyId: null,
    action: 'auth.signin',
    target: user.id,
    metadata: { method: 'magic_link' },
  });
  // Checked again on the way out, in case the stored value predates the check.
  return c.redirect(safeNext(login.next, new URL(c.req.url).origin), 302);
});

authRoutes.post('/logout', async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await destroySession(c.env.DB, token);
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  return c.body(null, 204);
});

// ── Device login for the CLI ───────────────────────────────────────────────
authRoutes.post('/device', async (c) => {
  const input = parse(DeviceStartRequest, await readJson(c));
  const origin = new URL(c.req.url).origin;
  const d = await startDevice(c.env.DB, input.client, input.machine);
  const body: DeviceStartResponse = {
    device_code: d.deviceCode,
    user_code: d.userCode,
    verification_uri: `${origin}/device`,
    verification_uri_complete: `${origin}/device?code=${d.userCode}`,
    interval: DEVICE_INTERVAL_S,
    expires_in: Math.floor((d.expiresAt - Date.now()) / 1000),
  };
  return c.json(body);
});

authRoutes.post('/device/token', async (c) => {
  const { device_code } = parse(DeviceTokenRequest, await readJson(c));
  const r = await pollDevice(c.env.DB, device_code);
  switch (r.state) {
    case 'pending':
      return c.json({ error: 'authorization_pending' }, 428);
    case 'slow_down':
      return c.json({ error: 'slow_down' }, 429);
    case 'denied':
      return c.json({ error: 'access_denied' }, 403);
    case 'expired':
      return c.json({ error: 'expired_token' }, 410);
    case 'approved': {
      const row = r.row;
      if (!row.user_id) return c.json({ error: 'expired_token' }, 410);
      const scopes = row.scopes
        ? (JSON.parse(row.scopes) as ('read' | 'write')[])
        : ['read', 'write'];
      const { key, secret } = await createKey(c.env.DB, c.env.KEY_PEPPER, {
        userId: row.user_id,
        label: `${row.client} on ${row.machine}`,
        machine: row.machine,
        client: row.client,
        scopes: scopes as ('read' | 'write')[],
        project: row.project_slug,
      });
      await audit(c.env.DB, {
        spaceId: null,
        actorUserId: row.user_id,
        actorKeyId: key.id,
        action: 'key.create',
        target: key.id,
        metadata: { via: 'device', client: row.client },
      });
      const origin = new URL(c.req.url).origin;
      const body: DeviceTokenResponse = { key, secret, api_url: origin, mcp_url: `${origin}/mcp` };
      return c.json(body);
    }
  }
});

authRoutes.get('/device/:code', async (c) => {
  requirePrincipal(c);
  const row = await getPendingByUserCode(c.env.DB, c.req.param('code'));
  if (!row) throw notFound('That code is invalid or has expired. Run `brain login` again.');
  return c.json(toDeviceInfo(row));
});

authRoutes.post('/device/approve', async (c) => {
  const p = requirePrincipal(c);
  if (p.via !== 'session')
    throw new HttpError(403, 'Forbidden', 'Approve devices from the web app.');
  const input = parse(DeviceApproveRequest, await readJson(c));
  const done = await decideDevice(
    c.env.DB,
    input.user_code,
    p.userId,
    input.approve,
    input.scopes,
    input.project ?? null,
  );
  if (!done) throw notFound('That code is invalid or has expired.');
  return c.body(null, 204);
});

// ── Passkeys (WebAuthn) ────────────────────────────────────────────────────
authRoutes.post('/passkey/register/options', async (c) => {
  requirePasskeys(c);
  requireOwnOrigin(c);
  const input = parse(PasskeyRegisterOptionsRequest, await readOptionalJson(c));
  const p = c.get('principal');
  if (p) {
    // Signed in: add a passkey to this account.
    if (p.via !== 'session') throw forbidden('Manage sign-in methods from the web app.');
    const user = await getUser(c.env.DB, p.userId);
    if (!user) throw forbidden();
    return c.json(
      await registrationOptions(c.env, c.req.url, { kind: 'existing', user }, input.name),
    );
  }
  // Not signed in: create a new account with this email and passkey.
  if (!input.email) {
    throw new HttpError(
      400,
      'Email required',
      'Sign in first, or give an email to create an account.',
      { verified: false },
    );
  }
  await limitEmail(c, input.email);
  return c.json(
    await registrationOptions(c.env, c.req.url, { kind: 'signup', email: input.email }, input.name),
  );
});

authRoutes.post('/passkey/register/verify', async (c) => {
  requirePasskeys(c);
  requireOwnOrigin(c);
  const input = parse(PasskeyVerifyRequest, await readJson(c));
  const p = c.get('principal');
  const r = await verifyRegistration(
    c.env,
    c.req.url,
    input.response as unknown as RegistrationResponseJSON,
    p?.via === 'session' ? p.userId : null,
    input.name,
  );
  const actor = { spaceId: null, actorUserId: r.user.id, actorKeyId: null, target: r.user.id };
  if (r.created) {
    await audit(c.env.DB, { ...actor, action: 'auth.signup', metadata: { method: 'passkey' } });
  }
  await audit(c.env.DB, {
    ...actor,
    action: 'auth.passkey.register',
    target: r.passkey.id,
    metadata: { device_type: r.passkey.device_type },
  });
  if (r.created) {
    await startSession(c, r.user.id);
    await audit(c.env.DB, {
      ...actor,
      action: 'auth.signin',
      metadata: { method: 'passkey', passkey_id: r.passkey.id },
    });
  }
  const body: PasskeyVerifyResponse = { verified: true, passkey: toPasskey(r.passkey) };
  return c.json(body);
});

authRoutes.post('/passkey/login/options', async (c) => {
  requirePasskeys(c);
  requireOwnOrigin(c);
  const input = parse(PasskeyLoginOptionsRequest, await readOptionalJson(c));
  if (input.email) await limitEmail(c, input.email);
  return c.json(await authenticationOptions(c.env, c.req.url));
});

authRoutes.post('/passkey/login/verify', async (c) => {
  requirePasskeys(c);
  requireOwnOrigin(c);
  const input = parse(PasskeyVerifyRequest, await readJson(c));
  let r;
  try {
    r = await verifyAuthentication(
      c.env,
      c.req.url,
      input.response as unknown as AuthenticationResponseJSON,
    );
  } catch (err) {
    if (err instanceof CounterRegressionError) {
      await audit(c.env.DB, {
        spaceId: null,
        actorUserId: err.passkey.user_id,
        actorKeyId: null,
        action: 'auth.passkey.counter_regression',
        target: err.passkey.id,
        metadata: { stored: err.passkey.counter, received: err.received },
      });
    }
    throw err;
  }
  if (!mayUseEmail(c.env, r.user.email)) {
    throw new HttpError(403, 'Sign-in not allowed', 'This account cannot sign in here.', {
      verified: false,
    });
  }
  await startSession(c, r.user.id);
  await audit(c.env.DB, {
    spaceId: null,
    actorUserId: r.user.id,
    actorKeyId: null,
    action: 'auth.signin',
    target: r.user.id,
    metadata: { method: 'passkey', passkey_id: r.passkey.id },
  });
  const body: PasskeyVerifyResponse = { verified: true };
  return c.json(body);
});

authRoutes.get('/passkeys', async (c) => {
  const p = requireSession(c);
  const rows = await listPasskeys(c.env.DB, p.userId);
  const body: Page<Passkey> = { items: rows.map(toPasskey), next_cursor: null };
  return c.json(body);
});

authRoutes.patch('/passkeys/:id', async (c) => {
  const p = requireSession(c);
  const { name } = parse(RenamePasskeyRequest, await readJson(c));
  const row = await renamePasskey(c.env.DB, p.userId, c.req.param('id'), name);
  if (!row) throw notFound('No such passkey.');
  await audit(c.env.DB, {
    spaceId: null,
    actorUserId: p.userId,
    actorKeyId: null,
    action: 'auth.passkey.rename',
    target: row.id,
  });
  return c.json(toPasskey(row));
});

authRoutes.delete('/passkeys/:id', async (c) => {
  const p = requireSession(c);
  const id = c.req.param('id');
  if (!(await getPasskey(c.env.DB, p.userId, id))) throw notFound('No such passkey.');
  if (!(await deletePasskeyUnlessLast(c.env, p.userId, id))) {
    throw conflict(
      'This is your last way to sign in. Add another passkey or link Google before removing it.',
    );
  }
  await audit(c.env.DB, {
    spaceId: null,
    actorUserId: p.userId,
    actorKeyId: null,
    action: 'auth.passkey.delete',
    target: id,
  });
  return c.body(null, 204);
});

// ── Sign in with Google (OIDC) ─────────────────────────────────────────────
authRoutes.get('/google/start', async (c) => {
  if (!googleEnabled(c.env)) throw notFound('Google sign-in is not configured on this server.');
  return googleStart(c);
});

authRoutes.get('/google/callback', async (c) => {
  if (!googleEnabled(c.env)) throw notFound('Google sign-in is not configured on this server.');
  return googleCallback(c);
});
