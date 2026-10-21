import type { Env } from '../env';
import { decryptSecret } from '../lib/crypto';
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

export async function vaultFor(env: Env, space: SpaceVaultConfig): Promise<VaultStore> {
  if (space.vault_provider === 'github') {
    if (!space.vault_repo || !space.vault_token_enc || !env.VAULT_KEK) {
      throw new Error('GitHub vault is not fully configured for this space');
    }
    const token = await decryptSecret(env.VAULT_KEK, space.vault_token_enc);
    return new GitHubVaultStore(space.vault_repo, space.vault_branch ?? 'main', token);
  }
  return new ManagedVaultStore(env.DB, space.id);
}
