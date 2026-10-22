import { applyChanges, isIndexable, rebuildIndex } from '@second-brain/db';
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../auth/principal';
import type { Env } from '../env';
import { audit } from '../services/audit';
import { COMPARE_FILE_LIMIT, type GitHubVaultStore } from './github';
import { githubVaultFor, type SpaceVaultConfig } from './index';

/**
 * Keeps a GitHub space's index in step with its repository (HLD §4.3, FR-VLT-07).
 *
 * The index records the commit it reflects in `sync_state.last_indexed_sha`. A sync moves it to a
 * target commit by re-indexing only the Markdown paths that changed in between; anything it can't
 * do incrementally (unknown base, force-push, huge diff) falls back to a full rebuild, which is
 * also what the nightly cron does. Two syncs racing can leave the older commit recorded; the next
 * push compares from that older commit, and the drift check catches it otherwise, so the index
 * always converges.
 */

/** A drift check runs at most this often per space. */
export const DRIFT_INTERVAL_MS = 10 * 60 * 1000;

export interface SyncState {
  last_indexed_sha: string | null;
  last_synced_at: number | null;
  last_checked_at: number | null;
  last_sync_error: string | null;
}

export async function getSyncState(db: D1Database, spaceId: string): Promise<SyncState | null> {
  return db
    .prepare(
      'SELECT last_indexed_sha, last_synced_at, last_checked_at, last_sync_error FROM sync_state WHERE space_id = ?',
    )
    .bind(spaceId)
    .first<SyncState>();
}

/** Records that the index matches `sha` as of now. */
export async function markSynced(db: D1Database, spaceId: string, sha: string | null) {
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO sync_state (space_id, last_indexed_sha, last_synced_at, last_checked_at, last_sync_error)
       VALUES (?1, ?2, ?3, ?3, NULL)
       ON CONFLICT (space_id) DO UPDATE SET last_indexed_sha = ?2, last_synced_at = ?3,
         last_checked_at = ?3, last_sync_error = NULL`,
    )
    .bind(spaceId, sha, now)
    .run();
}

export async function markSyncError(db: D1Database, spaceId: string, err: unknown) {
  const message = (err instanceof Error ? err.message : 'unknown error').slice(0, 200);
  await db
    .prepare(
      `INSERT INTO sync_state (space_id, last_sync_error) VALUES (?1, ?2)
       ON CONFLICT (space_id) DO UPDATE SET last_sync_error = ?2`,
    )
    .bind(spaceId, message)
    .run();
}

export interface SyncResult {
  mode: 'noop' | 'incremental' | 'full';
  sha: string | null;
  indexed: number;
  removed: number;
}

/** Re-indexes exactly `paths` (non-Markdown and hidden paths are ignored) as of commit `sha`. */
export async function syncPaths(
  env: Env,
  vault: GitHubVaultStore,
  spaceId: string,
  paths: Iterable<string>,
  sha: string,
): Promise<SyncResult> {
  const wanted = [...new Set(paths)].filter(isIndexable);
  const files = await vault.readPaths(wanted, sha);
  const upserts: { path: string; content: string }[] = [];
  const deletes: string[] = [];
  for (const [path, file] of files) {
    if (file) upserts.push({ path, content: file.content });
    else deletes.push(path);
  }
  const r = await applyChanges(env.DB, spaceId, { upserts, deletes }, sha);
  await markSynced(env.DB, spaceId, sha);
  return { mode: 'incremental', sha, indexed: r.indexed, removed: r.removed };
}

/** Full rebuild from the repository's current head. */
export async function syncFull(
  env: Env,
  vault: GitHubVaultStore,
  spaceId: string,
): Promise<SyncResult> {
  const head = await vault.head();
  const files = await vault.readAll();
  const r = await rebuildIndex(
    env.DB,
    spaceId,
    files.map((f) => ({ path: f.path, content: f.content })),
    head,
  );
  await markSynced(env.DB, spaceId, head);
  return { mode: 'full', sha: head, indexed: r.indexed, removed: r.removed };
}

/**
 * Brings the index from `from` (what it reflects now) to `to`, using the compare API to find the
 * changed paths. Falls back to a full rebuild when history was rewritten or the diff is too big
 * to list.
 */
export async function syncBetween(
  env: Env,
  vault: GitHubVaultStore,
  spaceId: string,
  from: string | null,
  to: string,
): Promise<SyncResult> {
  if (from === to) {
    await markSynced(env.DB, spaceId, to);
    return { mode: 'noop', sha: to, indexed: 0, removed: 0 };
  }
  if (!from) return syncFull(env, vault, spaceId);
  const diff = await vault.compare(from, to);
  if (!diff || diff.status !== 'ahead' || diff.files.length >= COMPARE_FILE_LIMIT) {
    return syncFull(env, vault, spaceId);
  }
  const paths = diff.files.flatMap((f) =>
    f.previous_filename ? [f.filename, f.previous_filename] : [f.filename],
  );
  return syncPaths(env, vault, spaceId, paths, to);
}

/**
 * Cheap drift check (safety net for missed webhooks): compares the branch head with the indexed
 * commit and catches up incrementally. Returns null when another request already claimed it.
 */
export async function driftSync(env: Env, space: SpaceVaultConfig): Promise<SyncResult | null> {
  const now = Date.now();
  const claim = await env.DB.prepare(
    `INSERT INTO sync_state (space_id, last_checked_at) VALUES (?1, ?2)
     ON CONFLICT (space_id) DO UPDATE SET last_checked_at = ?2
     WHERE sync_state.last_checked_at IS NULL OR sync_state.last_checked_at < ?3`,
  )
    .bind(space.id, now, now - DRIFT_INTERVAL_MS)
    .run();
  if ((claim.meta.changes ?? 0) !== 1) return null;
  try {
    const vault = await githubVaultFor(env, space);
    const head = await vault.head();
    const state = await getSyncState(env.DB, space.id);
    if (!head) return null;
    const result = await syncBetween(env, vault, space.id, state?.last_indexed_sha ?? null, head);
    if (result.mode !== 'noop') {
      await audit(env.DB, {
        spaceId: space.id,
        actorUserId: null,
        actorKeyId: null,
        action: 'vault.github.sync',
        target: head,
        metadata: {
          trigger: 'drift',
          mode: result.mode,
          indexed: result.indexed,
          removed: result.removed,
        },
      });
    }
    return result;
  } catch (err) {
    await markSyncError(env.DB, space.id, err);
    logSyncError(space.id, 'drift', err);
    return null;
  }
}

export function logSyncError(spaceId: string, trigger: string, err: unknown) {
  console.error(
    JSON.stringify({
      level: 'error',
      job: 'vault-sync',
      trigger,
      space: spaceId,
      error: err instanceof Error ? err.name : 'unknown',
      message: err instanceof Error ? err.message.slice(0, 200) : 'unknown',
    }),
  );
}

/**
 * Middleware: when the caller can read a GitHub space whose last check is older than
 * DRIFT_INTERVAL_MS, run a drift check after the response (ctx.waitUntil), so it adds no
 * latency. Costs one D1 read per request, and only for callers with GitHub spaces.
 */
export const driftCheck: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  const github = c.get('principal')?.spaces.filter((s) => s.vault_provider === 'github') ?? [];
  if (github.length === 0) return;
  let ctx: ExecutionContext;
  try {
    ctx = c.executionCtx as ExecutionContext;
  } catch {
    return; // no execution context (e.g. app.request in a unit test)
  }
  ctx.waitUntil(checkDrift(c.env, github));
};

async function checkDrift(env: Env, spaces: SpaceVaultConfig[]): Promise<void> {
  try {
    const fresh = await env.DB.prepare(
      `SELECT space_id FROM sync_state WHERE space_id IN (SELECT value FROM json_each(?1))
         AND last_checked_at >= ?2`,
    )
      .bind(JSON.stringify(spaces.map((s) => s.id)), Date.now() - DRIFT_INTERVAL_MS)
      .all<{ space_id: string }>();
    const skip = new Set(fresh.results.map((r) => r.space_id));
    await Promise.all(spaces.filter((s) => !skip.has(s.id)).map((s) => driftSync(env, s)));
  } catch (err) {
    logSyncError(spaces[0]?.id ?? 'unknown', 'drift', err);
  }
}
