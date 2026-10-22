import { rm } from 'node:fs/promises';
import path from 'node:path';
import { brainHome, ensureBrainHome, readJsonFile, writeJsonFile } from './config';
import type { Ctx } from './context';

export const KEYCHAIN_SERVICE = 'second-brain';

/** The subset of `@napi-rs/keyring` we use (kept structural so tests can pass a fake). */
export interface KeyringEntry {
  getPassword(): string | null;
  setPassword(password: string): void;
  deletePassword(): boolean;
}
export interface KeyringModule {
  Entry: new (
    service: string,
    account: string,
    options?: { linux?: { store?: 'secret-service' | 'keyutils' } },
  ) => KeyringEntry;
}

export type SecretBackend = 'keychain' | 'file';

interface CredentialsFile {
  version: 1;
  secrets: Record<string, string>;
}

export function credentialsPath(ctx: Ctx): string {
  return path.join(brainHome(ctx), 'credentials.json');
}

export function backendLabel(ctx: Ctx, backend: SecretBackend): string {
  if (backend === 'file') return `${credentialsPath(ctx)} (mode 0600)`;
  if (ctx.platform === 'darwin') return 'the macOS Keychain';
  if (ctx.platform === 'win32') return 'Windows Credential Manager';
  return 'the Secret Service keyring';
}

function keychainDisabled(ctx: Ctx): boolean {
  const v = (ctx.env.SECOND_BRAIN_KEYCHAIN ?? '').toLowerCase();
  return v === '0' || v === 'off' || v === 'false' || v === 'no' || v === 'file';
}

function reason(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.split('\n')[0]!.slice(0, 160);
}

/**
 * API key secrets live in the OS keychain (service `second-brain`, account = API origin). When no
 * keychain is usable (headless Linux without Secret Service, missing native binding, or
 * `SECOND_BRAIN_KEYCHAIN=off`) they fall back to `~/.second-brain/credentials.json`, mode 0600.
 */
export class SecretStore {
  private keyring: KeyringModule | null | undefined;
  /** Set when the keychain failed during this process, so we stop retrying it. */
  private keychainError: string | undefined;

  constructor(private readonly ctx: Ctx) {}

  private async entry(account: string): Promise<KeyringEntry | null> {
    if (keychainDisabled(this.ctx) || this.keychainError) return null;
    if (this.keyring === undefined) this.keyring = await this.ctx.loadKeyring();
    if (!this.keyring) {
      this.keychainError = 'native keychain module is not available for this platform';
      return null;
    }
    try {
      // On Linux, require Secret Service: the kernel keyring (keyutils) fallback is cleared on
      // logout/reboot, which would silently lose the key. Without it we use the 0600 file.
      return new this.keyring.Entry(KEYCHAIN_SERVICE, account, {
        linux: { store: 'secret-service' },
      });
    } catch (err) {
      this.keychainError = reason(err);
      return null;
    }
  }

  /** Why the keychain is not being used, if it is not. */
  get unavailableReason(): string | undefined {
    if (keychainDisabled(this.ctx)) return 'disabled by SECOND_BRAIN_KEYCHAIN';
    return this.keychainError;
  }

  async set(
    account: string,
    secret: string,
  ): Promise<{ backend: SecretBackend; warning?: string }> {
    const entry = await this.entry(account);
    if (entry) {
      try {
        entry.setPassword(secret);
        // Don't leave an older plaintext copy behind.
        await this.removeFromFile(account);
        return { backend: 'keychain' };
      } catch (err) {
        this.keychainError = reason(err);
      }
    }
    await this.writeToFile(account, secret);
    const why = this.unavailableReason ?? 'unknown error';
    return {
      backend: 'file',
      warning: `OS keychain unavailable (${why}); stored the key in ${credentialsPath(this.ctx)} with mode 0600.`,
    };
  }

  async get(account: string): Promise<{ secret: string; backend: SecretBackend } | null> {
    const entry = await this.entry(account);
    if (entry) {
      try {
        const secret = entry.getPassword();
        if (secret) return { secret, backend: 'keychain' };
      } catch (err) {
        this.keychainError = reason(err);
      }
    }
    const file = await readJsonFile<CredentialsFile>(credentialsPath(this.ctx));
    const secret = file?.secrets?.[account];
    return secret ? { secret, backend: 'file' } : null;
  }

  /** Removes the secret from both the keychain and the fallback file. */
  async delete(account: string): Promise<boolean> {
    let removed = false;
    const entry = await this.entry(account);
    if (entry) {
      try {
        removed = entry.deletePassword() || removed;
      } catch (err) {
        this.keychainError = reason(err);
      }
    }
    return (await this.removeFromFile(account)) || removed;
  }

  private async writeToFile(account: string, secret: string): Promise<void> {
    await ensureBrainHome(this.ctx);
    const file = credentialsPath(this.ctx);
    const current = await readJsonFile<CredentialsFile>(file);
    const next: CredentialsFile = {
      version: 1,
      secrets: { ...(current?.secrets ?? {}), [account]: secret },
    };
    await writeJsonFile(file, next, 0o600);
  }

  private async removeFromFile(account: string): Promise<boolean> {
    const file = credentialsPath(this.ctx);
    const current = await readJsonFile<CredentialsFile>(file);
    if (!current?.secrets || !(account in current.secrets)) return false;
    const { [account]: _removed, ...rest } = current.secrets;
    if (Object.keys(rest).length === 0) await rm(file, { force: true });
    else await writeJsonFile(file, { version: 1, secrets: rest }, 0o600);
    return true;
  }
}
