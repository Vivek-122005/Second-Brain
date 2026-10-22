import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

/**
 * An OAuth protocol error (RFC 6749 §5.2, RFC 7591 §3.2.2). These endpoints answer with
 * `{ error, error_description }` instead of the API's problem+json, because OAuth clients expect it.
 */
export class OAuthError extends Error {
  constructor(
    public readonly status: ContentfulStatusCode,
    public readonly code: string,
    public readonly description: string,
  ) {
    super(description);
    this.name = 'OAuthError';
  }
}

export const NO_STORE = { 'cache-control': 'no-store', pragma: 'no-cache' } as const;

export function oauthErrorResponse(c: Context, err: OAuthError): Response {
  const headers: Record<string, string> = { ...NO_STORE };
  if (err.code === 'invalid_client' && err.status === 401) {
    headers['www-authenticate'] = 'Basic realm="second-brain"';
  }
  return c.json({ error: err.code, error_description: err.description }, err.status, headers);
}
