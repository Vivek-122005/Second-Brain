import type { Env } from '../env';
import { decryptSecret, encryptSecret } from '../lib/crypto';
import { GitHubVaultStore } from './github';
import { ManagedVaultStore } from './managed';
import type { VaultStore } from './types';

export * from './types';

export interface SpaceVaultConfig {
  id: string;
  vault_provider: 'managed' | 'github';
  vault_repo: string | null;
  vault_branch: string | null;
  vault_token_enc: string | null;
}

/** Which column a sealed secret belongs to; part of the AAD so ciphertexts can't be swapped. */
export type SpaceSecretKind = 'vault_token' | 'webhook_secret';

function aad(spaceId: string, kind: SpaceSecretKind): string {
  return `second-brain:space:${spaceId}:${kind}`;
}

function requireKek(env: Env): string {
  if (!env.VAULT_KEK) throw new Error('VAULT_KEK is not configured');
  return env.VAULT_KEK;
}

/** AES-256-GCM with the VAULT_KEK; the AAD binds the ciphertext to one space and column. */
export function sealSpaceSecret(
  env: Env,
  spaceId: string,
  kind: SpaceSecretKind,
  plaintext: string,
): Promise<string> {
  return encryptSecret(requireKek(env), plaintext, aad(spaceId, kind));
}

export function openSpaceSecret(
  env: Env,
  spaceId: string,
  kind: SpaceSecretKind,
  sealed: string,
): Promise<string> {
  return decryptSecret(requireKek(env), sealed, aad(spaceId, kind));
}

export async function githubVaultFor(env: Env, space: SpaceVaultConfig): Promise<GitHubVaultStore> {
  if (!space.vault_repo || !space.vault_token_enc || !env.VAULT_KEK) {
    throw new Error('GitHub vault is not fully configured for this space');
  }
  const token = await openSpaceSecret(env, space.id, 'vault_token', space.vault_token_enc);
  return new GitHubVaultStore(space.vault_repo, space.vault_branch ?? 'main', token);
}

export async function vaultFor(env: Env, space: SpaceVaultConfig): Promise<VaultStore> {
  if (space.vault_provider === 'github') return githubVaultFor(env, space);
  return new ManagedVaultStore(env.DB, space.id);
}
