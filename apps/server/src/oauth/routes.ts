import type { KeyScope, OAuthGrantsResponse } from '@second-brain/schema';
import { type Context, Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { cors } from 'hono/cors';
import { type AppEnv, requirePrincipal, requireScope } from '../auth/principal';
import { SESSION_COOKIE, verifySession, type WebSessionRow } from '../auth/sessions';
import { notFound } from '../lib/http';
import { audit } from '../services/audit';
import { getUser, readableSpaces } from '../services/spaces';
import {
  authenticateClient,
  getClient,
  isLoopback,
  matchRedirectUri,
  type OAuthClientRow,
  readClientCredentials,
  redirectUris,
  registerClient,
  registrationResponse,
} from './clients';
import { consentPage, csrfToken, errorPage, PAGE_HEADERS, verifyCsrf } from './consent';
import { NO_STORE, OAuthError, oauthErrorResponse } from './errors';
import { listGrants, revokeGrant } from './grants';
import {
  AS_METADATA_PATH,
  authorizationServerMetadata,
  issuer,
  parseScopeParam,
  PRM_PATH,
  protectedResourceMetadata,
} from './metadata';
import {
  CHALLENGE_RE,
  checkResource,
  createCode,
  exchangeCode,
  refreshTokens,
  revokeToken,
  upsertGrant,
} from './tokens';

/**
 * The OAuth 2.1 authorization server for MCP clients (LLD §8): discovery, dynamic client
 * registration, the consent screen, the token and revocation endpoints. Mounted at the root.
 */
export const oauthRoutes = new Hono<AppEnv>();

// Discovery, registration, token and revocation are called by clients, some from a browser; they
// never use cookies, so any origin may call them. The consent screen is not CORS-enabled.
const publicCors = cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['authorization', 'content-type', 'mcp-protocol-version'],
  maxAge: 86_400,
});
oauthRoutes.use('/.well-known/*', publicCors);
oauthRoutes.use('/oauth/register', publicCors);
oauthRoutes.use('/oauth/token', publicCors);
oauthRoutes.use('/oauth/revoke', publicCors);

const originOf = (c: Context) => new URL(c.req.url).origin;

/** Runs an OAuth endpoint and turns `OAuthError` into the RFC 6749 JSON error shape. */
function endpoint(fn: (c: Context<AppEnv>) => Promise<Response>) {
  return async (c: Context<AppEnv>) => {
    try {
      return await fn(c);
    } catch (err) {
      if (err instanceof OAuthError) return oauthErrorResponse(c, err);
      throw err;
    }
  };
}

/** Reads a form (or, leniently, JSON) body into a flat string map. */
async function readForm(c: Context): Promise<Record<string, string>> {
  const type = c.req.header('content-type') ?? '';
  let raw: Record<string, unknown> = {};
  try {
    if (type.includes('application/json')) raw = (await c.req.json()) as Record<string, unknown>;
    else raw = (await c.req.parseBody()) as Record<string, unknown>;
  } catch {
    throw new OAuthError(400, 'invalid_request', 'The request body could not be parsed.');
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw ?? {})) if (typeof v === 'string') out[k] = v;
  return out;
}

// ── Discovery ──────────────────────────────────────────────────────────────
const prm = (c: Context) => c.json(protectedResourceMetadata(originOf(c)));
oauthRoutes.get(PRM_PATH, prm);
oauthRoutes.get(`${PRM_PATH}/mcp`, prm);
oauthRoutes.get(AS_METADATA_PATH, (c) => c.json(authorizationServerMetadata(originOf(c))));

// ── Dynamic client registration (RFC 7591) ─────────────────────────────────
oauthRoutes.post(
  '/oauth/register',
  endpoint(async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new OAuthError(400, 'invalid_client_metadata', 'Body must be a JSON object.');
    }
    const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
    const client = await registerClient(c.env.DB, c.env.KEY_PEPPER, body, ip);
    return c.json(registrationResponse(client), 201, NO_STORE);
  }),
);

// ── Authorization endpoint ─────────────────────────────────────────────────
interface AuthorizeRequest {
  client: OAuthClientRow;
  redirectUri: string;
  state: string | undefined;
  codeChallenge: string;
  scopes: KeyScope[];
  resource: string;
}

type Validation =
  | { kind: 'ok'; req: AuthorizeRequest }
  /** Client or redirect URI is bad: never redirect, show an error page (OAuth 2.1 §4.1.2.1). */
  | { kind: 'page'; title: string; message: string }
  | { kind: 'redirect'; location: string };

function callback(
  redirectUri: string,
  origin: string,
  params: Record<string, string | undefined>,
): string {
  const url = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
  url.searchParams.set('iss', issuer(origin));
  return url.toString();
}

async function validateAuthorize(
  c: Context<AppEnv>,
  p: Record<string, string | undefined>,
): Promise<Validation> {
  const origin = originOf(c);
  const client = p.client_id ? await getClient(c.env.DB, p.client_id) : null;
  if (!client) {
    return {
      kind: 'page',
      title: 'Unknown app',
      message: 'This app is not registered with Second Brain, or its registration has expired.',
    };
  }
  const registered = redirectUris(client);
  let redirectUri = p.redirect_uri;
  if (!redirectUri && registered.length === 1) redirectUri = registered[0];
  if (!redirectUri || !matchRedirectUri(registered, redirectUri)) {
    return {
      kind: 'page',
      title: 'Invalid redirect',
      message: 'The app asked to return to an address it did not register.',
    };
  }
  const fail = (error: string, description: string): Validation => ({
    kind: 'redirect',
    location: callback(redirectUri, origin, {
      error,
      error_description: description,
      state: p.state,
    }),
  });
  if (p.response_type !== 'code')
    return fail('unsupported_response_type', 'Only response_type=code is supported.');
  if (!p.code_challenge || !CHALLENGE_RE.test(p.code_challenge))
    return fail('invalid_request', 'A PKCE code_challenge is required.');
  if (p.code_challenge_method !== 'S256')
    return fail('invalid_request', 'code_challenge_method must be S256.');
  let resource: string;
  try {
    resource = checkResource(origin, p.resource);
  } catch (err) {
    if (err instanceof OAuthError) return fail(err.code, err.description);
    throw err;
  }
  return {
    kind: 'ok',
    req: {
      client,
      redirectUri,
      state: p.state,
      codeChallenge: p.code_challenge,
      scopes: parseScopeParam(p.scope),
      resource,
    },
  };
}

function htmlPage(c: Context, status: 400 | 403, html: string): Response {
  return c.body(html, status, PAGE_HEADERS);
}

async function webSession(c: Context<AppEnv>): Promise<WebSessionRow | null> {
  const cookie = getCookie(c, SESSION_COOKIE);
  return cookie ? verifySession(c.env.DB, cookie) : null;
}

/**
 * Sends a visitor without a web session to the web app's sign-in page. `next` is the full,
 * same-origin authorize URL; the web app accepts only same-origin destinations and opens /oauth/
 * ones with a full-page navigation once the user has signed in.
 */
function loginRedirect(c: Context, authorizePathAndQuery: string): Response {
  const next = `${originOf(c)}${authorizePathAndQuery}`;
  return c.redirect(`/login?next=${encodeURIComponent(next)}`, 302);
}

const AUTHORIZE_FIELDS = [
  'response_type',
  'client_id',
  'redirect_uri',
  'state',
  'scope',
  'code_challenge',
  'code_challenge_method',
  'resource',
] as const;

oauthRoutes.get('/oauth/authorize', async (c) => {
  const v = await validateAuthorize(c, c.req.query());
  if (v.kind === 'page') return htmlPage(c, 400, errorPage(v.title, v.message));
  if (v.kind === 'redirect') return c.redirect(v.location, 302);
  const { req } = v;

  const session = await webSession(c);
  const url = new URL(c.req.url);
  if (!session) return loginRedirect(c, url.pathname + url.search);
  const user = await getUser(c.env.DB, session.user_id);
  const spaces = user ? await readableSpaces(c.env.DB, user.id) : [];
  if (!user || !spaces.length) return loginRedirect(c, url.pathname + url.search);

  const hidden: Record<string, string> = {
    response_type: 'code',
    client_id: req.client.id,
    redirect_uri: req.redirectUri,
    code_challenge: req.codeChallenge,
    code_challenge_method: 'S256',
    scope: req.scopes.join(' '),
    resource: req.resource,
    csrf: await csrfToken(c.env.KEY_PEPPER, session.id_hash),
  };
  if (req.state !== undefined) hidden.state = req.state;
  const redirect = new URL(req.redirectUri);
  return c.body(
    consentPage({
      clientName: req.client.name,
      redirectUri: redirect,
      loopback: isLoopback(redirect),
      email: user.email,
      scopes: req.scopes,
      spaces,
      hidden,
    }),
    200,
    PAGE_HEADERS,
  );
});

oauthRoutes.post('/oauth/authorize', async (c) => {
  const form: Record<string, string> = {};
  for (const [k, val] of Object.entries(await c.req.parseBody()))
    if (typeof val === 'string') form[k] = val;

  // Cross-site form posts are refused before anything else (defence in depth with the CSRF token).
  const origin = c.req.header('origin');
  const site = c.req.header('sec-fetch-site');
  if ((origin && origin !== originOf(c)) || (site && site !== 'same-origin')) {
    return htmlPage(
      c,
      403,
      errorPage('Request blocked', 'This request did not come from Second Brain.'),
    );
  }

  const v = await validateAuthorize(c, form);
  if (v.kind === 'page') return htmlPage(c, 400, errorPage(v.title, v.message));
  if (v.kind === 'redirect') return c.redirect(v.location, 302);
  const { req } = v;

  const session = await webSession(c);
  if (!session) {
    const query = new URLSearchParams();
    for (const k of AUTHORIZE_FIELDS) if (form[k] !== undefined) query.set(k, form[k]);
    return loginRedirect(c, `/oauth/authorize?${query.toString()}`);
  }
  if (!(await verifyCsrf(c.env.KEY_PEPPER, session.id_hash, form.csrf ?? ''))) {
    return htmlPage(
      c,
      403,
      errorPage('Request expired', 'This consent page expired or was not opened by you.'),
    );
  }

  const db = c.env.DB;
  const back = (params: Record<string, string | undefined>) =>
    c.redirect(callback(req.redirectUri, originOf(c), { ...params, state: req.state }), 302);

  if (form.decision !== 'approve') {
    await audit(db, {
      spaceId: null,
      actorUserId: session.user_id,
      actorKeyId: null,
      action: 'oauth.consent.deny',
      target: req.client.id,
    });
    return back({ error: 'access_denied', error_description: 'The user denied access.' });
  }

  const spaces = await readableSpaces(db, session.user_id);
  const space = spaces.find((s) => s.id === form.space_id);
  if (!space) return htmlPage(c, 400, errorPage('Unknown space', 'Choose one of your spaces.'));
  const scopes = req.scopes.filter((s) => s === 'read' || form.scope_write === '1');

  const grant = await upsertGrant(db, {
    userId: session.user_id,
    clientId: req.client.id,
    spaceId: space.id,
    scopes,
  });
  const code = await createCode(db, {
    grant,
    redirectUri: req.redirectUri,
    codeChallenge: req.codeChallenge,
    scopes,
    resource: req.resource,
  });
  await audit(db, {
    spaceId: space.id,
    actorUserId: session.user_id,
    actorKeyId: grant.id,
    action: 'oauth.consent',
    target: grant.id,
    metadata: { client_id: req.client.id, scopes },
  });
  return back({ code });
});

// ── Token endpoint ─────────────────────────────────────────────────────────
oauthRoutes.post(
  '/oauth/token',
  endpoint(async (c) => {
    const form = await readForm(c);
    const client = await authenticateClient(
      c.env.DB,
      c.env.KEY_PEPPER,
      readClientCredentials(c.req.header('authorization'), form),
    );
    const grantTypes = JSON.parse(client.grant_types) as string[];
    const type = form.grant_type ?? '';
    if (!grantTypes.includes(type)) {
      throw new OAuthError(
        400,
        type === 'authorization_code' || type === 'refresh_token'
          ? 'unauthorized_client'
          : 'unsupported_grant_type',
        `grant_type "${type.slice(0, 40)}" is not allowed for this client.`,
      );
    }
    const body =
      type === 'authorization_code'
        ? await exchangeCode(c.env, client, form, originOf(c))
        : await refreshTokens(c.env, client, form, originOf(c));
    return c.json(body, 200, NO_STORE);
  }),
);

// ── Revocation endpoint (RFC 7009) ─────────────────────────────────────────
oauthRoutes.post(
  '/oauth/revoke',
  endpoint(async (c) => {
    const form = await readForm(c);
    if (!form.token) throw new OAuthError(400, 'invalid_request', 'token is required.');
    const creds = readClientCredentials(c.req.header('authorization'), form);
    // Public clients may identify themselves; holding the token is enough to give it up.
    const client = creds.clientId
      ? await authenticateClient(c.env.DB, c.env.KEY_PEPPER, creds)
      : null;
    await revokeToken(c.env.DB, client, form.token);
    return c.body(null, 200, NO_STORE);
  }),
);

// ── Connected apps for the web app (/api/v1/oauth) ─────────────────────────
export const oauthApiRoutes = new Hono<AppEnv>();

oauthApiRoutes.get('/grants', async (c) => {
  const p = requirePrincipal(c);
  const body: OAuthGrantsResponse = {
    items: await listGrants(c.env.DB, p.userId),
    next_cursor: null,
  };
  return c.json(body);
});

oauthApiRoutes.delete('/grants/:id', async (c) => {
  const p = requirePrincipal(c);
  requireScope(p, 'write');
  const id = c.req.param('id');
  if (!(await revokeGrant(c.env.DB, p.userId, id)))
    throw notFound('No connected app with that id.');
  await audit(c.env.DB, {
    spaceId: null,
    actorUserId: p.userId,
    actorKeyId: p.keyId,
    action: 'oauth.grant.revoke',
    target: id,
  });
  return c.body(null, 204);
});
