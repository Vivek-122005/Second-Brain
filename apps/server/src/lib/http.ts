import type { ProblemDetails } from '@second-brain/schema';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { z } from 'zod';

/** A domain error mapped to an RFC 9457 problem response in one place (engineering standards). */
export class HttpError extends Error {
  constructor(
    public readonly status: ContentfulStatusCode,
    public readonly title: string,
    public readonly detail?: string,
    public readonly extra: Partial<ProblemDetails> & Record<string, unknown> = {},
    /** Extra response headers, e.g. `Retry-After` on 429. */
    public readonly headers: Record<string, string> = {},
  ) {
    super(detail ?? title);
    this.name = 'HttpError';
  }
}

export const badRequest = (detail: string) => new HttpError(400, 'Bad request', detail);
export const unauthorized = (detail = 'Sign in or send a valid API key.') =>
  new HttpError(401, 'Unauthorized', detail);
export const forbidden = (detail = 'You do not have access to this resource.') =>
  new HttpError(403, 'Forbidden', detail);
export const notFound = (detail = 'Not found.') => new HttpError(404, 'Not found', detail);
export const conflict = (detail: string, extra: Record<string, unknown> = {}) =>
  new HttpError(409, 'Conflict', detail, extra);

export function problem(c: Context, err: HttpError): Response {
  const body: ProblemDetails & Record<string, unknown> = {
    type: `https://second-brain.dev/problems/${err.status}`,
    title: err.title,
    status: err.status,
    ...(err.detail ? { detail: err.detail } : {}),
    ...err.extra,
  };
  return c.body(JSON.stringify(body), err.status, {
    ...err.headers,
    'content-type': 'application/problem+json',
  });
}

/** Parses with Zod and converts failures into a 400 problem with field errors. */
export function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const r = schema.safeParse(value);
  if (r.success) return r.data;
  throw new HttpError(400, 'Validation failed', 'The request is not valid.', {
    errors: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
  });
}

export async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw badRequest('Body must be valid JSON.');
  }
}
