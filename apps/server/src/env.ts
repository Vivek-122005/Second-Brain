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
