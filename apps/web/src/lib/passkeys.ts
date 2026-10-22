import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
  WebAuthnError,
} from '@simplewebauthn/browser';
import type { ApiClient } from '../api/client';

export function passkeysSupported(): boolean {
  try {
    return browserSupportsWebAuthn();
  } catch {
    return false;
  }
}

/** Human message for a failed ceremony; `null` when the user simply cancelled. */
export function passkeyErrorMessage(err: unknown): string | null {
  if (err instanceof WebAuthnError) {
    if (err.code === 'ERROR_CEREMONY_ABORTED') return null;
    if (err.code === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED') {
      return 'This device already has a passkey for your account.';
    }
  }
  if (err instanceof Error && err.name === 'NotAllowedError') return null;
  if (err instanceof Error && 'title' in err) {
    const e = err as Error & { title: string; detail?: string };
    return e.detail ?? e.title;
  }
  return 'The passkey could not be used. Try again, or use another sign-in method.';
}

/** Discoverable-credential sign-in: options → browser prompt → verify (sets the session). */
export async function signInWithPasskey(api: ApiClient): Promise<void> {
  const optionsJSON = await api.passkeyLoginOptions({});
  const response = await startAuthentication({ optionsJSON });
  await api.passkeyLoginVerify({ response });
}

/** Adds a passkey to the signed-in account. */
export async function registerPasskey(api: ApiClient, name?: string): Promise<void> {
  const optionsJSON = await api.passkeyRegisterOptions(name ? { name } : {});
  const response = await startRegistration({ optionsJSON });
  await api.passkeyRegisterVerify({ response, ...(name ? { name } : {}) });
}
