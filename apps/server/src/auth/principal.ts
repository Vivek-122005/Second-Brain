import type { KeyScope } from '@second-brain/schema';
import type { Context, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { csv, type Env } from '../env';
import { forbidden, unauthorized } from '../lib/http';
import { ACCESS_TOKEN_PREFIX } from '../oauth/metadata';
import { principalFromAccessToken } from '../oauth/tokens';
import { getUser, readableSpaces, type SpaceRow } from '../services/spaces';
import { parseScopes, touchKey, verifyKey } from './keys';
import { SESSION_COOKIE, verifySession } from './sessions';

/** Who is calling, and what they may touch. Built once per request and checked on every call. */
export interface Principal {
  userId: string;
  email: string;
  name: string | null;
  via: 'key' | 'session' | 'oauth';
  /** API key id, or the OAuth grant id when `via` is `oauth`. */
  keyId: string | null;
  keyPrefix: string | null;
  /** The key's client, or the OAuth client's registered name. */
  client: string | null;
  machine: string | null;
  scopes: KeyScope[];
  /** Spaces this caller may read (already narrowed by a key's space restriction). */
  spaces: SpaceRow[];
  defaultSpace: SpaceRow;
  /** Set when a key is limited to one project. */
  project: string | null;
}

export type AppEnv = {
  Bindings: Env;
  Variables: { principal: Principal | null; requestId: string };
};

async function fromBearer(
  env: Env,
  token: string,
  ctx: ExecutionContext | undefined,
): Promise<Principal | null> {
  const key = await verifyKey(env.DB, env.KEY_PEPPER, token);
  if (!key) return null;
  const user = await getUser(env.DB, key.user_id);
  if (!user) return null;
  let spaces = await readableSpaces(env.DB, user.id);
  if (key.space_id) spaces = spaces.filter((s) => s.id === key.space_id);
  const defaultSpace = spaces[0];
  if (!defaultSpace) return null;
  const touch = touchKey(env.DB, key);
  if (ctx) ctx.waitUntil(touch);
  else await touch;
  return {
    userId: user.id,
    email: user.email,
    name: user.name,
    via: 'key',
    keyId: key.id,
    keyPrefix: key.prefix,
    client: key.client,
    machine: key.machine,
    scopes: parseScopes(key.scopes),
    spaces,
    defaultSpace,
    project: key.project_slug,
  };
}

async function fromSession(env: Env, cookie: string): Promise<Principal | null> {
  const session = await verifySession(env.DB, cookie);
  if (!session) return null;
  const user = await getUser(env.DB, session.user_id);
  if (!user) return null;
  const spaces = await readableSpaces(env.DB, user.id);
  const defaultSpace = spaces[0];
  if (!defaultSpace) return null;
  return {
    userId: user.id,
    email: user.email,
    name: user.name,
    via: 'session',
    keyId: null,
    keyPrefix: null,
    client: 'web',
    machine: null,
    scopes: ['read', 'write'],
    spaces,
    defaultSpace,
    project: null,
  };
}

function executionCtx(c: Context): ExecutionContext | undefined {
  try {
    return c.executionCtx as ExecutionContext;
  } catch {
    return undefined;
  }
}

/**
 * Resolves the caller from `Authorization: Bearer` (an API key, or an OAuth access token, which is
 * only accepted on /mcp) or the session cookie. Never throws.
 */
export const identify: MiddlewareHandler<AppEnv> = async (c, next) => {
  let principal: Principal | null = null;
  const auth = c.req.header('authorization');
  if (auth?.toLowerCase().startsWith('bearer ')) {
    const token = auth.slice(7).trim();
    principal = token.startsWith(ACCESS_TOKEN_PREFIX)
      ? await principalFromAccessToken(c.env, token, c.req.url, executionCtx(c))
      : await fromBearer(c.env, token, executionCtx(c));
  } else {
    const cookie = getCookie(c, SESSION_COOKIE);
    if (cookie) principal = await fromSession(c.env, cookie);
    // Cookie-authenticated mutations must come from our own web origin (CSRF defence).
    if (principal && !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
      const origin = c.req.header('origin');
      const self = new URL(c.req.url).origin;
      const allowed = new Set([self, ...csv(c.env.APP_ORIGINS)]);
      if (!origin || !allowed.has(origin)) principal = null;
    }
  }
  c.set('principal', principal);
  await next();
};

export function requirePrincipal(c: Context<AppEnv>): Principal {
  const p = c.get('principal');
  if (!p) throw unauthorized();
  return p;
}

export function requireScope(p: Principal, scope: KeyScope): void {
  if (!p.scopes.includes(scope)) throw forbidden(`This key does not have the "${scope}" scope.`);
}

/** Resolves the space a request targets, defaulting to the caller's default space. */
export function spaceFor(p: Principal, spaceId?: string | null): SpaceRow {
  if (!spaceId) return p.defaultSpace;
  const s = p.spaces.find((x) => x.id === spaceId);
  if (!s) throw forbidden('You do not have access to that space.');
  return s;
}

/** A project-restricted key may only touch its own project. */
export function checkProject(p: Principal, project: string | null | undefined): void {
  if (p.project && project && project !== p.project) {
    throw forbidden(`This key is limited to the project "${p.project}".`);
  }
}
