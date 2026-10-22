import { isIndexable, rebuildIndex } from '@second-brain/db';
import {
  ConnectGitHubVaultRequest,
  type ConnectGitHubVaultResponse,
  type DisconnectGitHubVaultResponse,
  type VaultStatus,
} from '@second-brain/schema';
import { type Context, Hono } from 'hono';
import { type AppEnv, type Principal, requirePrincipal, requireScope } from '../auth/principal';
import { randomToken } from '../lib/crypto';
import { conflict, forbidden, HttpError, notFound, parse, readJson } from '../lib/http';
import { audit } from '../services/audit';
import { commitMeta } from '../services/notes';
import type { SpaceRow } from '../services/spaces';
import { githubVaultFor, sealSpaceSecret, VaultConflictError } from '../vault';
import { GitHubError, GitHubVaultStore } from '../vault/github';
import { ManagedVaultStore } from '../vault/managed';
import { getSyncState, markSyncError, markSynced, type SyncState } from '../vault/sync';

/**
 * Connect a space's vault to a GitHub repository and back (FR-VLT-07, FR-VLT-09, ADR-0008).
 *
 *   GET    /spaces/:id/vault          status
 *   POST   /spaces/:id/vault/github   connect (push_managed | adopt_repo)
 *   DELETE /spaces/:id/vault/github   disconnect: import the repo's latest files, back to managed
 *
 * Space owner only; every change is audited. The token and webhook secret are stored encrypted
 * (AES-256-GCM, VAULT_KEK, AAD bound to the space) and never logged or returned.
 */
export const vaultRoutes = new Hono<AppEnv>();

type VaultSpace = SpaceRow & { webhook_id: number | null; webhook_last_delivery_at: number | null };

/** Content per managed commit when importing; keeps each D1 batch well under its size limits. */
const IMPORT_CHUNK_BYTES = 1_000_000;
const MAX_ATTEMPTS = 3;

async function ownedSpace(c: Context<AppEnv>, write: boolean): Promise<[Principal, VaultSpace]> {
  const p = requirePrincipal(c);
  const id = c.req.param('id');
  if (!p.spaces.some((s) => s.id === id)) throw notFound('No such space.');
  if (write) {
    requireScope(p, 'write');
    if (p.project) throw forbidden('Project-limited keys cannot change the vault.');
  }
  const space = await c.env.DB.prepare('SELECT * FROM spaces WHERE id = ?')
    .bind(id)
    .first<VaultSpace>();
  if (!space) throw notFound('No such space.');
  if (space.owner_user_id !== p.userId) throw forbidden('Only the space owner can do this.');
  return [p, space];
}

function payloadUrl(c: Context<AppEnv>, spaceId: string): string {
  return `${new URL(c.req.url).origin}/webhooks/github/${spaceId}`;
}

function iso(ms: number | null | undefined): string | null {
  return ms ? new Date(ms).toISOString() : null;
}

function toStatus(space: VaultSpace, state: SyncState | null, url: string): VaultStatus {
  const github = space.vault_provider === 'github';
  return {
    space_id: space.id,
    provider: space.vault_provider,
    repo: github ? space.vault_repo : null,
    branch: github ? space.vault_branch : null,
    last_synced_sha: state?.last_indexed_sha ?? null,
    last_synced_at: iso(state?.last_synced_at),
    last_sync_error: state?.last_sync_error ?? null,
    webhook: github
      ? {
          configured: space.webhook_id !== null || space.webhook_last_delivery_at !== null,
          auto_created: space.webhook_id !== null,
          payload_url: url,
          last_delivery_at: iso(space.webhook_last_delivery_at),
        }
      : null,
  };
}

async function loadStatus(c: Context<AppEnv>, spaceId: string): Promise<VaultStatus> {
  const space = await c.env.DB.prepare('SELECT * FROM spaces WHERE id = ?')
    .bind(spaceId)
    .first<VaultSpace>();
  if (!space) throw notFound('No such space.');
  return toStatus(space, await getSyncState(c.env.DB, spaceId), payloadUrl(c, spaceId));
}

/** Maps GitHub failures to answers the owner can act on. */
async function github<T>(repo: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof VaultConflictError) {
      throw conflict('The repository changed while we were working on it. Try again.');
    }
    if (err instanceof GitHubError && err.status === 401) {
      throw new HttpError(
        400,
        'GitHub rejected the token',
        'GitHub answered 401. Check that the token is correct and has not expired or been revoked.',
      );
    }
    if (err instanceof GitHubError && err.status === 403) {
      throw new HttpError(
        400,
        'The token lacks permission',
        `GitHub answered 403. The token needs "Contents: Read and write" on ${repo}.`,
      );
    }
    if (err instanceof GitHubError) {
      throw new HttpError(502, 'GitHub is unavailable', 'GitHub did not answer. Try again soon.');
    }
    throw err;
  }
}

vaultRoutes.get('/spaces/:id/vault', async (c) => {
  const [, space] = await ownedSpace(c, false);
  return c.json(toStatus(space, await getSyncState(c.env.DB, space.id), payloadUrl(c, space.id)));
});

vaultRoutes.post('/spaces/:id/vault/github', async (c) => {
  const [p, space] = await ownedSpace(c, true);
  if (!c.env.VAULT_KEK) {
    throw new HttpError(503, 'Not configured', 'GitHub vaults need VAULT_KEK set on the server.');
  }
  const input = parse(ConnectGitHubVaultRequest, await readJson(c));
  if (space.vault_provider === 'github') {
    throw conflict('This space is already connected to GitHub. Disconnect it first.');
  }

  // 1. Validate access: the repository, then the branch.
  const probe = new GitHubVaultStore(input.repo, input.branch ?? 'main', input.token);
  const info = await github(input.repo, () => probe.repoInfo());
  if (!info) {
    throw new HttpError(
      400,
      'Repository not found',
      `${input.repo} does not exist, or the token has no access to it.`,
    );
  }
  if (info.permissions && info.permissions.push === false) {
    throw new HttpError(
      400,
      'The token lacks permission',
      `The token can read ${input.repo} but not write to it.`,
    );
  }
  const branch = input.branch ?? info.default_branch;
  const vault = new GitHubVaultStore(input.repo, branch, input.token);
  let head = await github(input.repo, () => vault.head());
  const repoPaths = head ? await github(input.repo, () => vault.listPaths()) : [];
  const repoNotes = repoPaths.filter(isIndexable);

  const managed = new ManagedVaultStore(c.env.DB, space.id);
  const managedHead = await managed.head();
  const managedFiles = await managed.readAll();

  // 2. The initial direction.
  let files: { path: string; content: string }[];
  let commitSha: string | null = null;
  let exported = 0;
  if (input.direction === 'push_managed') {
    // A fresh repository often has a README; that does not count as "has notes".
    const notes = repoNotes.filter((path) => path.toLowerCase() !== 'readme.md');
    if (notes.length > 0 && !input.confirm_overwrite) {
      throw conflict(
        `${input.repo}@${branch} already has ${notes.length} notes. Pass confirm_overwrite: true to export on top of them, or use adopt_repo.`,
        { repo_notes: notes.length },
      );
    }
    if (managedFiles.length > 0) {
      const changes = managedFiles.map((f) => ({ path: f.path, content: f.content }));
      const meta = commitMeta(p, `Export ${changes.length} notes from Second Brain`);
      commitSha = await github(input.repo, () => vault.commit(changes, meta, head));
      head = commitSha;
      exported = changes.length;
    }
    // Index straight from what we just wrote unless the repo had notes of its own.
    files =
      repoNotes.length === 0 ? managedFiles : await github(input.repo, async () => vault.readAll());
  } else {
    if (!head) {
      throw new HttpError(
        400,
        'Nothing to adopt',
        `${input.repo} has no branch "${branch}" yet. Use push_managed to start it from this space.`,
      );
    }
    if (managedFiles.length > 0 && !input.confirm_overwrite) {
      throw conflict(
        `This space has ${managedFiles.length} notes that the repository's notes would replace. Pass confirm_overwrite: true, or use push_managed to keep them.`,
        { managed_notes: managedFiles.length },
      );
    }
    files = await github(input.repo, () => vault.readAll());
  }

  // 3. Switch the provider atomically: only if the space is still managed and its vault did not
  // move while we exported (a concurrent save would otherwise be lost).
  const secret = randomToken(40);
  const [tokenEnc, secretEnc] = await Promise.all([
    sealSpaceSecret(c.env, space.id, 'vault_token', input.token),
    sealSpaceSecret(c.env, space.id, 'webhook_secret', secret),
  ]);
  const switched = await c.env.DB.prepare(
    `UPDATE spaces SET vault_provider = 'github', vault_repo = ?2, vault_branch = ?3,
       vault_token_enc = ?4, webhook_secret_enc = ?5, webhook_id = NULL, webhook_last_delivery_at = NULL
     WHERE id = ?1 AND vault_provider = 'managed'
       AND (SELECT head FROM vault_heads WHERE space_id = ?1) IS ?6`,
  )
    .bind(space.id, input.repo, branch, tokenEnc, secretEnc, managedHead)
    .run();
  if ((switched.meta.changes ?? 0) !== 1) {
    throw conflict('The space changed while connecting. Try again.');
  }

  // 4. Rebuild the index from the repository's files.
  let indexed = 0;
  try {
    indexed = (
      await rebuildIndex(
        c.env.DB,
        space.id,
        files.map((f) => ({ path: f.path, content: f.content })),
        head,
      )
    ).indexed;
    await markSynced(c.env.DB, space.id, head);
  } catch (err) {
    // The switch stands; the drift check or the nightly rebuild completes the index.
    await markSyncError(c.env.DB, space.id, err);
  }

  // 5. The push webhook: create it when the token may, otherwise the owner adds it by hand.
  const url = payloadUrl(c, space.id);
  let hookId: number | null = null;
  let detail: string | null = null;
  if (input.create_webhook) {
    try {
      hookId = await vault.ensureWebhook(url, secret);
    } catch {
      hookId = null;
    }
    if (hookId === null) {
      detail =
        'The token cannot manage webhooks (it needs the "Webhooks: Read and write" repository permission). Add the webhook in the repository settings with this payload URL and secret.';
    } else {
      await c.env.DB.prepare('UPDATE spaces SET webhook_id = ? WHERE id = ?')
        .bind(hookId, space.id)
        .run();
    }
  } else {
    detail = 'Automatic setup was not requested. Add the webhook in the repository settings.';
  }

  await audit(c.env.DB, {
    spaceId: space.id,
    actorUserId: p.userId,
    actorKeyId: p.keyId,
    action: 'vault.github.connect',
    target: input.repo,
    metadata: {
      branch,
      direction: input.direction,
      exported,
      indexed,
      commit: commitSha,
      webhook_created: hookId !== null,
    },
  });

  const body: ConnectGitHubVaultResponse = {
    vault: await loadStatus(c, space.id),
    direction: input.direction,
    exported,
    indexed,
    commit_sha: commitSha,
    webhook: {
      payload_url: url,
      content_type: 'application/json',
      secret,
      events: ['push'],
      created: hookId !== null,
      detail,
    },
  };
  return c.json(body, 201);
});

vaultRoutes.delete('/spaces/:id/vault/github', async (c) => {
  const [p, space] = await ownedSpace(c, true);
  if (space.vault_provider !== 'github' || !space.vault_repo) {
    throw conflict('This space is not connected to GitHub.');
  }
  const repo = space.vault_repo;
  // Escape hatch when the repository can no longer be read (token revoked, repo deleted): switch
  // back without importing. The managed vault then holds what it had before connecting.
  const skipImport = c.req.query('skip_import') === 'true';
  const vault = await githubVaultFor(c.env, space);
  const managed = new ManagedVaultStore(c.env.DB, space.id);

  let imported = 0;
  let removed = 0;
  let commitSha: string | null = null;
  if (!skipImport) {
    // 1. Copy the repository's latest files into the managed vault. Repeat if someone pushed
    // meanwhile, so the managed copy matches the head we switch away from.
    for (let attempt = 1; ; attempt++) {
      const head = await github(repo, () => vault.head());
      const remote = await github(repo, () => vault.readAll());
      const local = new Map((await managed.readAll()).map((f) => [f.path, f.content]));
      const remotePaths = new Set(remote.map((f) => f.path));
      const puts = remote.filter((f) => local.get(f.path) !== f.content);
      const dels = [...local.keys()].filter((path) => !remotePaths.has(path));
      const changes = [
        ...puts.map((f) => ({ path: f.path, content: f.content as string | null })),
        ...dels.map((path) => ({ path, content: null })),
      ];
      const meta = commitMeta(p, `Import ${repo}@${(head ?? 'empty').slice(0, 12)} from GitHub`);
      for (const chunk of chunkBySize(changes)) {
        commitSha = await managed.commit(chunk, meta, await managed.head());
      }
      imported += puts.length;
      removed += dels.length;
      if ((await github(repo, () => vault.head())) === head) break;
      if (attempt >= MAX_ATTEMPTS) {
        throw conflict('The repository kept changing while disconnecting. Try again.');
      }
    }
  }

  // 2. Switch back atomically.
  const switched = await c.env.DB.prepare(
    `UPDATE spaces SET vault_provider = 'managed', vault_repo = NULL, vault_branch = NULL,
       vault_token_enc = NULL, webhook_secret_enc = NULL, webhook_id = NULL, webhook_last_delivery_at = NULL
     WHERE id = ? AND vault_provider = 'github'`,
  )
    .bind(space.id)
    .run();
  if ((switched.meta.changes ?? 0) !== 1) throw conflict('The space changed while disconnecting.');

  // 3. Remove the webhook we created (best effort: the token may already be revoked).
  let webhookRemoved = false;
  if (space.webhook_id !== null) {
    webhookRemoved = await vault.deleteWebhook(space.webhook_id).catch(() => false);
  }

  // 4. Rebuild the index from the managed vault and forget the old deliveries.
  const head = await managed.head();
  await rebuildIndex(
    c.env.DB,
    space.id,
    (await managed.readAll()).map((f) => ({ path: f.path, content: f.content })),
    head,
  );
  await markSynced(c.env.DB, space.id, head);
  await c.env.DB.prepare('DELETE FROM webhook_deliveries WHERE space_id = ?').bind(space.id).run();

  await audit(c.env.DB, {
    spaceId: space.id,
    actorUserId: p.userId,
    actorKeyId: p.keyId,
    action: 'vault.github.disconnect',
    target: repo,
    metadata: {
      imported,
      removed,
      commit: commitSha,
      skip_import: skipImport,
      webhook_removed: webhookRemoved,
    },
  });

  const body: DisconnectGitHubVaultResponse = {
    vault: await loadStatus(c, space.id),
    imported,
    removed,
    commit_sha: commitSha,
    webhook_removed: webhookRemoved,
  };
  return c.json(body);
});

function chunkBySize<T extends { content: string | null }>(items: T[]): T[][] {
  const chunks: T[][] = [];
  let current: T[] = [];
  let size = 0;
  for (const item of items) {
    const n = item.content?.length ?? 0;
    if (current.length > 0 && size + n > IMPORT_CHUNK_BYTES) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(item);
    size += n;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}
