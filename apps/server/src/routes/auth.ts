import {
  DeviceApproveRequest,
  DeviceStartRequest,
  type DeviceStartResponse,
  DeviceTokenRequest,
  type DeviceTokenResponse,
  MagicLinkRequest,
  type MagicLinkResponse,
} from '@second-brain/schema';
import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { createKey } from '../auth/keys';
import {
  decideDevice,
  DEVICE_INTERVAL_S,
  getPendingByUserCode,
  pollDevice,
  startDevice,
  toDeviceInfo,
} from '../auth/device';
import { type AppEnv, requirePrincipal } from '../auth/principal';
import {
  consumeLoginToken,
  createLoginToken,
  createSession,
  destroySession,
  SESSION_COOKIE,
  SESSION_TTL_MS,
} from '../auth/sessions';
import { csv, isDev } from '../env';
import { HttpError, notFound, parse, readJson } from '../lib/http';
import { audit } from '../services/audit';
import { sendMagicLink } from '../services/mail';
import { upsertUserByEmail } from '../services/spaces';

export const authRoutes = new Hono<AppEnv>();

function mayUseEmail(env: AppEnv['Bindings'], email: string): boolean {
  if (env.SIGNUP_MODE === 'open') return true;
  return csv(env.ALLOWED_EMAILS)
    .map((e) => e.toLowerCase())
    .includes(email.toLowerCase());
}

authRoutes.post('/magic-link', async (c) => {
  const { email } = parse(MagicLinkRequest, await readJson(c));
  const origin = new URL(c.req.url).origin;
  const body: MagicLinkResponse = { sent: true };
  // Same response whether or not the email is allowed, so the endpoint can't be used to probe.
  if (!mayUseEmail(c.env, email)) return c.json(body, 202);

  const token = await createLoginToken(c.env.DB, email);
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
  const email = await consumeLoginToken(c.env.DB, token);
  if (!email) return c.redirect('/?signin=expired', 302);
  const user = await upsertUserByEmail(c.env.DB, email);
  const session = await createSession(c.env.DB, user.id);
  setCookie(c, SESSION_COOKIE, session.token, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === 'https:',
    sameSite: 'Lax',
    path: '/',
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
  await audit(c.env.DB, {
    spaceId: null,
    actorUserId: user.id,
    actorKeyId: null,
    action: 'auth.signin',
    target: user.id,
  });
  return c.redirect('/', 302);
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
