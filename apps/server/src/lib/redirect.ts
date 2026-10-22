/**
 * Post-sign-in destinations (`next` / `redirect`), checked so they can't become open redirects.
 *
 * Accepted: a same-origin relative path (`/notes?x=1#a`) or an absolute URL on our own origin
 * (`https://brain.example.com/notes`), which is reduced to its path. Everything else, including
 * protocol-relative `//host`, backslashes, control characters and other origins, yields `/`.
 */
export function safeNext(raw: string | undefined | null, selfOrigin: string): string {
  if (!raw || raw.length > 1024) return '/';
  if (hasUnsafeChars(raw)) return '/';
  let url: URL;
  if (raw.startsWith('/')) {
    if (raw.startsWith('//')) return '/';
    try {
      url = new URL(raw, selfOrigin);
    } catch {
      return '/';
    }
  } else {
    try {
      url = new URL(raw);
    } catch {
      return '/';
    }
  }
  if (url.origin !== selfOrigin) return '/';
  return `${url.pathname}${url.search}${url.hash}`;
}

/** Backslashes (browsers read them as slashes) and ASCII control characters. */
function hasUnsafeChars(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f || c === 0x5c) return true;
  }
  return false;
}
