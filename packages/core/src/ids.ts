const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * ULID (26 chars: 48-bit time + 80 bits of randomness), sortable by creation time.
 * Uses Web Crypto, which exists in Workers, browsers and Node ≥ 19.
 */
export function ulid(now: number = Date.now()): string {
  let time = '';
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let rand = '';
  for (const b of bytes) rand += CROCKFORD[b % 32];
  return time + rand;
}

export type IdPrefix =
  | 'prj'
  | 'ses'
  | 'top'
  | 'spc'
  | 'usr'
  | 'key'
  | 'org'
  | 'grt'
  | 'aud'
  | 'evt'
  | 'req'
  | 'not'
  | 'chk';

/** Prefixed id, e.g. `ses_01JB3...`. Prefixes make ids self-describing in logs and URLs. */
export function newId(prefix: IdPrefix, now?: number): string {
  return `${prefix}_${ulid(now)}`;
}

/** SHA-256 hex digest via Web Crypto. */
export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const data = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const digest = await crypto.subtle.digest('SHA-256', data as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
