/**
 * A software WebAuthn authenticator for tests: real P-256 keys, real CBOR attestation objects
 * ("none" format) and real ES256 assertion signatures, so @simplewebauthn/server verifies them
 * exactly as it would a browser's. Nothing about the server's verification is mocked.
 */

export function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data as BufferSource));
}

// ── Minimal CBOR encoder (unsigned/negative ints, byte and text strings, maps) ──
type Cbor = number | string | Uint8Array | Map<Cbor, Cbor>;

function head(major: number, n: number): Uint8Array {
  if (n < 24) return Uint8Array.of((major << 5) | n);
  if (n < 0x100) return Uint8Array.of((major << 5) | 24, n);
  if (n < 0x10000) return Uint8Array.of((major << 5) | 25, n >> 8, n & 0xff);
  return Uint8Array.of(
    (major << 5) | 26,
    (n >>> 24) & 0xff,
    (n >> 16) & 0xff,
    (n >> 8) & 0xff,
    n & 0xff,
  );
}

export function cbor(v: Cbor): Uint8Array {
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === 'string') {
    const b = new TextEncoder().encode(v);
    return concat(head(3, b.length), b);
  }
  if (v instanceof Uint8Array) return concat(head(2, v.length), v);
  const parts: Uint8Array[] = [head(5, v.size)];
  for (const [k, val] of v) parts.push(cbor(k), cbor(val));
  return concat(...parts);
}

/** Raw r||s (64 bytes) → ASN.1 DER, which WebAuthn uses for ES256 signatures. */
function derSignature(raw: Uint8Array): Uint8Array {
  const int = (b: Uint8Array) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    let x = b.slice(i);
    if ((x[0] ?? 0) & 0x80) x = concat(Uint8Array.of(0), x);
    return concat(Uint8Array.of(0x02, x.length), x);
  };
  const body = concat(int(raw.slice(0, 32)), int(raw.slice(32)));
  return concat(Uint8Array.of(0x30, body.length), body);
}

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_BE = 0x08;
const FLAG_BS = 0x10;
const FLAG_AT = 0x40;

interface CreationOptions {
  challenge: string;
  rp: { id?: string };
  user: { id: string };
}
interface RequestOptions {
  challenge: string;
  rpId?: string;
}

export interface Overrides {
  origin?: string;
  rpId?: string;
  counter?: number;
  /** Sign with a different key than the registered one. */
  wrongKey?: boolean;
  userHandle?: string | null;
  type?: string;
}

export class SoftAuthenticator {
  readonly credentialId = crypto.getRandomValues(new Uint8Array(16));
  /** Signature counter; stays 0 for authenticators without one (like synced passkeys). */
  counter = 0;
  userHandle: string | null = null;
  private constructor(
    private readonly keys: CryptoKeyPair,
    readonly origin: string,
    readonly synced: boolean,
  ) {}

  static async create(origin = 'http://app.test', synced = true): Promise<SoftAuthenticator> {
    const keys = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    return new SoftAuthenticator(keys, origin, synced);
  }

  get id(): string {
    return b64url(this.credentialId);
  }

  private flags(extra: number): number {
    return FLAG_UP | FLAG_UV | (this.synced ? FLAG_BE | FLAG_BS : 0) | extra;
  }

  private clientData(type: string, challenge: string, origin: string): Uint8Array {
    return new TextEncoder().encode(
      JSON.stringify({ type, challenge, origin, crossOrigin: false }),
    );
  }

  async register(input: unknown, o: Overrides = {}) {
    const options = input as CreationOptions;
    const rpId = o.rpId ?? options.rp.id ?? new URL(this.origin).hostname;
    this.userHandle = options.user.id;
    const jwk = (await crypto.subtle.exportKey('jwk', this.keys.publicKey)) as JsonWebKey;
    const coseKey = new Map<Cbor, Cbor>([
      [1, 2], // kty: EC2
      [3, -7], // alg: ES256
      [-1, 1], // crv: P-256
      [-2, fromB64url(jwk.x!)],
      [-3, fromB64url(jwk.y!)],
    ]);
    const count = new Uint8Array(4);
    new DataView(count.buffer).setUint32(0, this.counter);
    const credLen = Uint8Array.of(this.credentialId.length >> 8, this.credentialId.length & 0xff);
    const authData = concat(
      await sha256(new TextEncoder().encode(rpId)),
      Uint8Array.of(this.flags(FLAG_AT)),
      count,
      new Uint8Array(16), // AAGUID
      credLen,
      this.credentialId,
      cbor(coseKey),
    );
    const attestationObject = cbor(
      new Map<Cbor, Cbor>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', authData],
      ]),
    );
    const clientDataJSON = this.clientData(
      o.type ?? 'webauthn.create',
      options.challenge,
      o.origin ?? this.origin,
    );
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key' as const,
      response: {
        clientDataJSON: b64url(clientDataJSON),
        attestationObject: b64url(attestationObject),
        transports: ['internal', 'hybrid'],
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }

  async login(input: unknown, o: Overrides = {}) {
    const options = input as RequestOptions;
    const rpId = o.rpId ?? options.rpId ?? new URL(this.origin).hostname;
    if (o.counter !== undefined) this.counter = o.counter;
    const count = new Uint8Array(4);
    new DataView(count.buffer).setUint32(0, this.counter);
    const authData = concat(
      await sha256(new TextEncoder().encode(rpId)),
      Uint8Array.of(this.flags(0)),
      count,
    );
    const clientDataJSON = this.clientData(
      o.type ?? 'webauthn.get',
      options.challenge,
      o.origin ?? this.origin,
    );
    const key = o.wrongKey
      ? (
          (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, [
            'sign',
          ])) as CryptoKeyPair
        ).privateKey
      : this.keys.privateKey;
    const raw = new Uint8Array(
      await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        key,
        concat(authData, await sha256(clientDataJSON)) as BufferSource,
      ),
    );
    const handle = o.userHandle === undefined ? this.userHandle : o.userHandle;
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key' as const,
      response: {
        clientDataJSON: b64url(clientDataJSON),
        authenticatorData: b64url(authData),
        signature: b64url(derSignature(raw)),
        ...(handle ? { userHandle: handle } : {}),
      },
      clientExtensionResults: {},
    };
  }
}
