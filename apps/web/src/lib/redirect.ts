/** Paths the Worker renders itself (not SPA routes): leaving the app requires a full navigation. */
const SERVER_PATHS = ['/oauth/', '/api/', '/mcp', '/.well-known/'];

export interface Destination {
  /** Same-origin path, query and hash, e.g. `/oauth/authorize?client_id=…`. */
  href: string;
  /** True when the destination is server-rendered (e.g. the OAuth consent page). */
  server: boolean;
}

function isRelativePath(value: string): boolean {
  return value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\');
}

/**
 * Resolves a post-sign-in destination (`?next=` or `?redirect=`) without allowing an open
 * redirect: only relative paths or absolute URLs on this exact origin are accepted; anything else
 * (other hosts, protocol-relative `//evil`, `javascript:`, malformed values) falls back to `/`.
 */
export function resolveDestination(
  value: string | undefined,
  origin: string = globalThis.location?.origin ?? 'http://localhost',
): Destination {
  const fallback: Destination = { href: '/', server: false };
  if (!value) return fallback;
  let href: string;
  if (isRelativePath(value)) {
    href = value;
  } else {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return fallback;
    }
    if (url.origin !== origin) return fallback;
    href = `${url.pathname}${url.search}${url.hash}`;
  }
  // Normalise through URL so encoded tricks like `/%2F%2Fevil` stay on this origin.
  const resolved = new URL(href, origin);
  if (resolved.origin !== origin) return fallback;
  href = `${resolved.pathname}${resolved.search}${resolved.hash}`;
  const server = SERVER_PATHS.some(
    (p) => resolved.pathname === p.replace(/\/$/, '') || resolved.pathname.startsWith(p),
  );
  return { href, server };
}

/** Only same-app relative paths are allowed as a post-sign-in destination (no open redirect). */
export function safeRedirect(value: string | undefined): string {
  return resolveDestination(value).href;
}
