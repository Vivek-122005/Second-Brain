/**
 * Sign-in endpoints that are not in `@second-brain/schema` yet.
 *
 * TODO(schema): move these into packages/schema/src/api.ts once the server branch defines them,
 * then re-export them from ./contract like the other types.
 *
 * Shapes follow SimpleWebAuthn conventions: the options endpoints return the
 * `PublicKeyCredential{Creation,Request}OptionsJSON` the browser library expects, and the verify
 * endpoints take the library's response JSON.
 */
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/browser';

/** GET /api/v1/auth/providers (no auth). TODO(schema) */
export interface AuthProviders {
  passkey: boolean;
  google: boolean;
  magic_link: boolean;
}

/**
 * POST /api/v1/auth/magic-link. Extends the schema's `MagicLinkRequest` with `next`: where
 * /auth/verify sends you after signing in (same-origin only, checked again by the server).
 * TODO(schema)
 */
export interface MagicLinkInput {
  email: string;
  next?: string;
}

/** POST /api/v1/auth/passkey/register/options (session auth). TODO(schema) */
export interface PasskeyRegisterOptionsInput {
  /** Friendly name for the passkey, e.g. "MacBook Pro". */
  name?: string;
  /** Required only when creating a new account with a passkey (no session yet). */
  email?: string;
}
export type PasskeyRegisterOptionsResponse = PublicKeyCredentialCreationOptionsJSON;

/** POST /api/v1/auth/passkey/register/verify (session auth). TODO(schema) */
export interface PasskeyRegisterVerifyInput {
  response: RegistrationResponseJSON;
  name?: string;
}
export interface PasskeyRegisterVerifyResponse {
  verified: boolean;
}

/** POST /api/v1/auth/passkey/login/options (no auth). TODO(schema) */
export interface PasskeyLoginOptionsInput {
  /** Optional; omitted for discoverable-credential ("usernameless") sign-in. */
  email?: string;
}
export type PasskeyLoginOptionsResponse = PublicKeyCredentialRequestOptionsJSON;

/** POST /api/v1/auth/passkey/login/verify (no auth) → sets the session cookie. TODO(schema) */
export interface PasskeyLoginVerifyInput {
  response: AuthenticationResponseJSON;
}
export interface PasskeyLoginVerifyResponse {
  verified: boolean;
}

/** GET /api/v1/auth/google/start?redirect=… → 302 to Google, back to the app signed in. */
export const GOOGLE_START_PATH = '/api/v1/auth/google/start';

/** GET /api/v1/auth/passkeys (session auth). TODO(schema): `Passkey` */
export interface Passkey {
  id: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
  transports: string[];
}

/** PATCH /api/v1/auth/passkeys/:id. TODO(schema): `RenamePasskeyRequest` */
export interface RenamePasskeyInput {
  name: string;
}
/** DELETE /api/v1/auth/passkeys/:id → 204, or 409 when it is the account's last sign-in method. */
