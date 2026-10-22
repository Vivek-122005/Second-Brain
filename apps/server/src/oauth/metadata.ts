import type { KeyScope } from '@second-brain/schema';

/**
 * Constants and discovery documents for the OAuth 2.1 authorization server that MCP clients use
 * (MCP authorization spec, ADR-0007, LLD §8). The Worker is both the authorization server (issuer
 * = its origin) and the protected resource (`<origin>/mcp`).
 */

export const SUPPORTED_SCOPES: readonly KeyScope[] = ['read', 'write'];

export const CODE_TTL_MS = 60_000;
export const ACCESS_TTL_MS = 3_600_000;
export const REFRESH_TTL_MS = 30 * 86_400_000;
export const REGISTRATIONS_PER_IP_PER_HOUR = 20;

/** Token prefixes make leaked tokens easy to recognise and route `Authorization` headers. */
export const ACCESS_TOKEN_PREFIX = 'sb_oat_';
export const REFRESH_TOKEN_PREFIX = 'sb_ort_';
export const CODE_PREFIX = 'sb_oac_';
export const CLIENT_SECRET_PREFIX = 'sb_ocs_';

export const PRM_PATH = '/.well-known/oauth-protected-resource';
export const AS_METADATA_PATH = '/.well-known/oauth-authorization-server';

export type AuthMethod = 'none' | 'client_secret_post' | 'client_secret_basic';
export const AUTH_METHODS: readonly AuthMethod[] = [
  'none',
  'client_secret_post',
  'client_secret_basic',
];

export const issuer = (origin: string) => origin;
/** The canonical resource URI of the MCP endpoint (RFC 8707 audience). */
export const mcpResource = (origin: string) => `${origin}/mcp`;
/** Where clients find our protected-resource metadata; sent in `WWW-Authenticate` on 401. */
export const resourceMetadataUrl = (origin: string) => `${origin}${PRM_PATH}/mcp`;

/** RFC 9728 protected-resource metadata for `/mcp`. */
export function protectedResourceMetadata(origin: string) {
  return {
    resource: mcpResource(origin),
    authorization_servers: [issuer(origin)],
    scopes_supported: SUPPORTED_SCOPES,
    bearer_methods_supported: ['header'],
    resource_name: 'Second Brain',
    resource_documentation: 'https://github.com/Vivek-122005/Second-Brain#connect-a-client',
  };
}

/** RFC 8414 authorization-server metadata. */
export function authorizationServerMetadata(origin: string) {
  return {
    issuer: issuer(origin),
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    revocation_endpoint: `${origin}/oauth/revoke`,
    scopes_supported: SUPPORTED_SCOPES,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: AUTH_METHODS,
    revocation_endpoint_auth_methods_supported: AUTH_METHODS,
    code_challenge_methods_supported: ['S256'],
    authorization_response_iss_parameter_supported: true,
    service_documentation: 'https://github.com/Vivek-122005/Second-Brain#connect-a-client',
  };
}

/**
 * The `WWW-Authenticate` challenge for /mcp (RFC 6750 §3, RFC 9728 §5.1). `error` is set only when
 * the request carried a token that we rejected.
 */
export function bearerChallenge(origin: string, error?: 'invalid_token'): string {
  const parts = [
    'Bearer realm="second-brain"',
    `resource_metadata="${resourceMetadataUrl(origin)}"`,
    `scope="${SUPPORTED_SCOPES.join(' ')}"`,
  ];
  if (error) parts.push(`error="${error}"`);
  return parts.join(', ');
}

/** Parses a space-separated scope string, keeping only scopes we know. `read` is always included. */
export function parseScopeParam(scope: string | undefined | null): KeyScope[] {
  const asked = new Set((scope ?? '').split(/\s+/).filter(Boolean));
  const known = SUPPORTED_SCOPES.filter((s) => asked.has(s));
  // No known scope requested: offer everything, and let the user narrow it on the consent page.
  const out = new Set<KeyScope>(known.length ? known : SUPPORTED_SCOPES);
  out.add('read');
  return SUPPORTED_SCOPES.filter((s) => out.has(s));
}

export function scopesJson(scopes: KeyScope[]): string {
  return JSON.stringify(SUPPORTED_SCOPES.filter((s) => scopes.includes(s)));
}
