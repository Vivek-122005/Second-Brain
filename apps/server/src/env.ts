/** Worker bindings and configuration (wrangler.jsonc `vars` + secrets). */
export interface Env {
  DB: D1Database;
  ASSETS?: Fetcher;

  ENVIRONMENT: 'development' | 'test' | 'staging' | 'production';
  /** `open`: anyone may sign up. `allowlist`: only ALLOWED_EMAILS. */
  SIGNUP_MODE: 'open' | 'allowlist';
  /** Comma-separated emails allowed to sign in when SIGNUP_MODE = allowlist. */
  ALLOWED_EMAILS: string;
  /** Comma-separated origins allowed to make cookie-authenticated mutations. */
  APP_ORIGINS: string;
  EMAIL_FROM: string;

  /** Secret: HMAC pepper for API key hashes. */
  KEY_PEPPER: string;
  /** Secret: base64 32-byte key-encryption key for stored vault tokens. */
  VAULT_KEK?: string;
  /** Secret: Resend API key for magic-link emails. */
  RESEND_API_KEY?: string;

  // ── Optional semantic layer (ADR-0004). Search falls back to keyword when either is missing. ──
  /** Workers AI binding used to embed chunks and queries. */
  AI?: Ai;
  /** Vectorize index (768 dimensions, cosine) holding one vector per chunk. */
  VECTORIZE?: Vectorize;
  /** Embedding model id; changing it re-embeds every note. Default `@cf/baai/bge-base-en-v1.5`. */
  EMBEDDING_MODEL?: string;
  /** Max chunks the nightly catch-up job embeds per run (default 200). */
  SEMANTIC_CRON_CHUNK_CAP?: string;

  /** WebAuthn relying-party ID: the site's registrable domain, e.g. `brain.example.com`. */
  WEBAUTHN_RP_ID?: string;
  /** WebAuthn relying-party name shown by the authenticator. */
  WEBAUTHN_RP_NAME?: string;
  /** Google OAuth client ID. Google sign-in is enabled when it and the secret are set. */
  GOOGLE_CLIENT_ID?: string;
  /** Secret: Google OAuth client secret. */
  GOOGLE_CLIENT_SECRET?: string;

  /** `off` disables rate limiting (tests only). Anything else, or unset, enables it. */
  RATE_LIMITS?: string;
  /** Requests per minute per IP and per email on /api/v1/auth/* (D1 fallback only). */
  RATE_LIMIT_AUTH_PER_MIN?: string;
  /** Requests per minute per key or user on /api/v1/* and /mcp (D1 fallback only). */
  RATE_LIMIT_API_PER_MIN?: string;
  /** Workers Rate Limiting binding for /api/v1/auth/*. Without it, a D1 counter is used. */
  AUTH_RATE_LIMITER?: RateLimit;
  /** Workers Rate Limiting binding for /api/v1/* and /mcp. */
  API_RATE_LIMITER?: RateLimit;
}

export function isDev(env: Env): boolean {
  return env.ENVIRONMENT === 'development' || env.ENVIRONMENT === 'test';
}

export function csv(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
