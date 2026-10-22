import { ulid } from '@second-brain/core';
import { z } from 'zod';
import { hmacHex, randomToken, timingSafeEqual } from '../lib/crypto';
import {
  AUTH_METHODS,
  type AuthMethod,
  CLIENT_SECRET_PREFIX,
  REGISTRATIONS_PER_IP_PER_HOUR,
} from './metadata';
import { OAuthError } from './errors';

/** Dynamic client registration (RFC 7591) and redirect URI rules (OAuth 2.1 §2.3, RFC 8252). */

export interface OAuthClientRow {
  id: string;
  name: string;
  client_uri: string | null;
  redirect_uris: string;
  grant_types: string;
  token_endpoint_auth_method: AuthMethod;
  secret_hash: string | null;
  software_id: string | null;
  software_version: string | null;
  ip_hash: string;
  created_at: number;
}

/**
 * Private-use URI schemes of desktop MCP clients that cannot use a loopback redirect (RFC 8252
 * §7.1). PKCE protects the code if another app claims the scheme.
 */
const NATIVE_SCHEMES = new Set(['cursor', 'vscode', 'vscode-insiders', 'windsurf', 'claude']);
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export type RedirectCheck = { ok: true; url: URL } | { ok: false; reason: string };

/** https anywhere; http only on loopback (any port); a few known native-app schemes. */
export function checkRedirectUri(raw: string): RedirectCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: `"${raw.slice(0, 100)}" is not an absolute URL.` };
  }
  if (url.hash || raw.includes('#'))
    return { ok: false, reason: 'Redirect URIs cannot contain a fragment.' };
  if (url.username || url.password)
    return { ok: false, reason: 'Redirect URIs cannot contain credentials.' };
  const scheme = url.protocol.slice(0, -1);
  if (scheme === 'https' && url.hostname) return { ok: true, url };
  if (scheme === 'http' && LOOPBACK_HOSTS.has(url.hostname)) return { ok: true, url };
  if (NATIVE_SCHEMES.has(scheme)) return { ok: true, url };
  if (scheme === 'http')
    return { ok: false, reason: 'http redirect URIs are only allowed on localhost or 127.0.0.1.' };
  return { ok: false, reason: `The "${scheme}" scheme is not allowed for redirect URIs.` };
}

export function isLoopback(url: URL): boolean {
  return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
}

/**
 * Matches a requested redirect URI against the registered ones: exact string match, except that a
 * loopback URI may use any port (RFC 8252 §7.3).
 */
export function matchRedirectUri(registered: string[], requested: string): boolean {
  if (registered.includes(requested)) return true;
  let req: URL;
  try {
    req = new URL(requested);
  } catch {
    return false;
  }
  if (!isLoopback(req)) return false;
  return registered.some((r) => {
    try {
      const reg = new URL(r);
      return (
        isLoopback(reg) &&
        reg.hostname === req.hostname &&
        reg.pathname === req.pathname &&
        reg.search === req.search
      );
    } catch {
      return false;
    }
  });
}

export function redirectUris(client: Pick<OAuthClientRow, 'redirect_uris'>): string[] {
  return JSON.parse(client.redirect_uris) as string[];
}

export function redirectHosts(client: Pick<OAuthClientRow, 'redirect_uris'>): string[] {
  const hosts = redirectUris(client).map((u) => {
    try {
      const url = new URL(u);
      return url.hostname || url.protocol.slice(0, -1);
    } catch {
      return u;
    }
  });
  return [...new Set(hosts)];
}

const RegistrationRequest = z.object({
  redirect_uris: z.array(z.string().max(2000)).min(1).max(10),
  client_name: z.string().trim().min(1).max(100).optional(),
  client_uri: z.string().max(2000).optional(),
  grant_types: z.array(z.string()).max(5).optional(),
  response_types: z.array(z.string()).max(5).optional(),
  token_endpoint_auth_method: z.string().optional(),
  scope: z.string().max(200).optional(),
  software_id: z.string().max(200).optional(),
  software_version: z.string().max(100).optional(),
});

export interface RegisteredClient {
  row: OAuthClientRow;
  secret: string | null;
}

export async function registerClient(
  db: D1Database,
  pepper: string,
  body: unknown,
  ip: string,
): Promise<RegisteredClient> {
  const parsed = RegistrationRequest.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new OAuthError(
      400,
      'invalid_client_metadata',
      issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'Invalid client metadata.',
    );
  }
  const input = parsed.data;

  for (const uri of input.redirect_uris) {
    const check = checkRedirectUri(uri);
    if (!check.ok) throw new OAuthError(400, 'invalid_redirect_uri', check.reason);
  }

  let clientUri: string | null = null;
  if (input.client_uri) {
    try {
      const u = new URL(input.client_uri);
      if (u.protocol === 'https:' || u.protocol === 'http:') clientUri = u.toString();
    } catch {
      // An unusable client_uri is dropped rather than rejected; it is informational only.
    }
  }

  const grantTypes = input.grant_types ?? ['authorization_code', 'refresh_token'];
  if (!grantTypes.includes('authorization_code')) {
    throw new OAuthError(
      400,
      'invalid_client_metadata',
      'grant_types must include authorization_code.',
    );
  }
  if (grantTypes.some((g) => g !== 'authorization_code' && g !== 'refresh_token')) {
    throw new OAuthError(
      400,
      'invalid_client_metadata',
      'Only the authorization_code and refresh_token grant types are supported.',
    );
  }
  if (input.response_types && input.response_types.some((r) => r !== 'code')) {
    throw new OAuthError(
      400,
      'invalid_client_metadata',
      'Only the "code" response type is supported.',
    );
  }
  // RFC 7591 defaults to client_secret_basic, but MCP clients are public: default to "none".
  const method = (input.token_endpoint_auth_method ?? 'none') as AuthMethod;
  if (!AUTH_METHODS.includes(method)) {
    throw new OAuthError(
      400,
      'invalid_client_metadata',
      `token_endpoint_auth_method must be one of ${AUTH_METHODS.join(', ')}.`,
    );
  }

  const now = Date.now();
  const ipHash = await hmacHex(pepper, `oauth-register|${ip}`);
  const recent = await db
    .prepare('SELECT COUNT(*) AS n FROM oauth_clients WHERE ip_hash = ? AND created_at > ?')
    .bind(ipHash, now - 3_600_000)
    .first<{ n: number }>();
  if ((recent?.n ?? 0) >= REGISTRATIONS_PER_IP_PER_HOUR) {
    throw new OAuthError(
      429,
      'too_many_requests',
      'Too many client registrations from this address. Try again later.',
    );
  }

  const secret = method === 'none' ? null : `${CLIENT_SECRET_PREFIX}${randomToken(43)}`;
  const row: OAuthClientRow = {
    id: `ocl_${ulid(now)}`,
    name: input.client_name ?? 'Unnamed MCP client',
    client_uri: clientUri,
    redirect_uris: JSON.stringify(input.redirect_uris),
    grant_types: JSON.stringify([...new Set(grantTypes)]),
    token_endpoint_auth_method: method,
    secret_hash: secret ? await hmacHex(pepper, secret) : null,
    software_id: input.software_id ?? null,
    software_version: input.software_version ?? null,
    ip_hash: ipHash,
    created_at: now,
  };
  await db
    .prepare(
      `INSERT INTO oauth_clients (id, name, client_uri, redirect_uris, grant_types, token_endpoint_auth_method,
                                  secret_hash, software_id, software_version, ip_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.id,
      row.name,
      row.client_uri,
      row.redirect_uris,
      row.grant_types,
      row.token_endpoint_auth_method,
      row.secret_hash,
      row.software_id,
      row.software_version,
      row.ip_hash,
      row.created_at,
    )
    .run();
  return { row, secret };
}

/** The RFC 7591 §3.2.1 response body. */
export function registrationResponse(c: RegisteredClient) {
  const { row, secret } = c;
  return {
    client_id: row.id,
    client_id_issued_at: Math.floor(row.created_at / 1000),
    ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
    client_name: row.name,
    ...(row.client_uri ? { client_uri: row.client_uri } : {}),
    redirect_uris: redirectUris(row),
    grant_types: JSON.parse(row.grant_types) as string[],
    response_types: ['code'],
    token_endpoint_auth_method: row.token_endpoint_auth_method,
    scope: 'read write',
    ...(row.software_id ? { software_id: row.software_id } : {}),
    ...(row.software_version ? { software_version: row.software_version } : {}),
  };
}

export async function getClient(db: D1Database, id: string): Promise<OAuthClientRow | null> {
  if (!/^ocl_[0-9A-Z]{26}$/.test(id)) return null;
  return db.prepare('SELECT * FROM oauth_clients WHERE id = ?').bind(id).first<OAuthClientRow>();
}

export interface ClientCredentials {
  clientId: string | null;
  secret: string | null;
  /** Which method the request used. */
  method: AuthMethod;
}

/** Reads client credentials from `Authorization: Basic` or the form body (RFC 6749 §2.3.1). */
export function readClientCredentials(
  authorization: string | undefined,
  form: Record<string, string>,
): ClientCredentials {
  if (authorization?.toLowerCase().startsWith('basic ')) {
    try {
      const decoded = atob(authorization.slice(6).trim());
      const i = decoded.indexOf(':');
      if (i > 0) {
        return {
          clientId: decodeURIComponent(decoded.slice(0, i)),
          secret: decodeURIComponent(decoded.slice(i + 1)),
          method: 'client_secret_basic',
        };
      }
    } catch {
      // fall through to invalid_client below
    }
    throw new OAuthError(401, 'invalid_client', 'Malformed Basic credentials.');
  }
  if (form.client_secret) {
    return {
      clientId: form.client_id ?? null,
      secret: form.client_secret,
      method: 'client_secret_post',
    };
  }
  return { clientId: form.client_id ?? null, secret: null, method: 'none' };
}

/** Authenticates the client at the token or revocation endpoint. */
export async function authenticateClient(
  db: D1Database,
  pepper: string,
  creds: ClientCredentials,
): Promise<OAuthClientRow> {
  if (!creds.clientId) throw new OAuthError(401, 'invalid_client', 'client_id is required.');
  const client = await getClient(db, creds.clientId);
  if (!client) throw new OAuthError(401, 'invalid_client', 'Unknown client.');
  if (client.token_endpoint_auth_method === 'none') {
    if (creds.secret) throw new OAuthError(401, 'invalid_client', 'This client has no secret.');
    return client;
  }
  if (!creds.secret || !client.secret_hash)
    throw new OAuthError(401, 'invalid_client', 'Client authentication failed.');
  if (!timingSafeEqual(client.secret_hash, await hmacHex(pepper, creds.secret)))
    throw new OAuthError(401, 'invalid_client', 'Client authentication failed.');
  return client;
}
