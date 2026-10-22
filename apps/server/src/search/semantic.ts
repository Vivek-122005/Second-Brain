import {
  chunkCounts,
  chunksForEmbedding,
  type ChunkForEmbedding,
  deleteEmbeddings,
  type EmbeddingRecord,
  noteId,
  orphanedEmbeddings,
  recordEmbeddings,
  spaceEmbeddings,
  staleNotes,
} from '@second-brain/db';
import type { Env } from '../env';
import { defer } from '../lib/defer';
import type { SpaceRow } from '../services/spaces';
import { DEFAULT_EMBEDDING_MODEL, type Embedder, workersAiEmbedder } from './embedder';
import { type ChunkVector, chunkVectorIds, type VectorIndex, vectorizeIndex } from './vectors';

/**
 * Embedding pipeline for the optional semantic layer (ADR-0004, FR-SRC-06).
 *
 * - Only notes whose content hash (or the model) changed are embedded (`embeddings_meta`).
 * - Every run has a chunk cap, so a large first import spreads over several nightly runs.
 * - Vectors of removed notes and of chunks that disappeared are deleted.
 * - Runs only for spaces with `semantic_enabled = 1` and only when both bindings exist.
 */

export interface Semantic {
  embedder: Embedder;
  vectors: VectorIndex;
}

/** Chunks embedded right after a write (the rest is picked up by the nightly job). */
export const POST_WRITE_CHUNK_CAP = 100;
/** Chunks embedded right after a space owner switches semantic search on. */
export const BACKFILL_CHUNK_CAP = 200;
/** Default per-run cap of the nightly catch-up job. */
export const CRON_CHUNK_CAP = 200;
/** Notes considered per run; bounds the stale-note query. */
const STALE_SCAN = 500;

/** The semantic layer for this deployment, or null when AI or Vectorize is not bound. */
export function semanticFor(env: Env): Semantic | null {
  if (!env.AI || !env.VECTORIZE) return null;
  return {
    embedder: workersAiEmbedder(env.AI, env.EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL),
    vectors: vectorizeIndex(env.VECTORIZE),
  };
}

/** Self-contained chunk text for embedding: title + heading path + body (LLD §4.1). */
export function embeddingText(c: Pick<ChunkForEmbedding, 'title' | 'heading_path' | 'body'>) {
  return [c.title, c.heading_path, c.body].filter((s) => s.trim().length > 0).join('\n\n');
}

export interface EmbedRunResult {
  notes: number;
  chunks: number;
  deletedVectors: number;
  /** True when stale notes were left for a later run because of the cap. */
  remaining: boolean;
}

/** Deletes vectors and bookkeeping for notes that no longer exist in the index. */
export async function purgeOrphans(
  db: D1Database,
  sem: Semantic,
  spaceId: string,
): Promise<number> {
  let deleted = 0;
  for (;;) {
    const orphans = await orphanedEmbeddings(db, spaceId, STALE_SCAN);
    if (orphans.length === 0) return deleted;
    const ids = orphans.flatMap((o) => chunkVectorIds(o.note_id, 0, o.chunk_count));
    if (ids.length) await sem.vectors.deleteByIds(ids);
    await deleteEmbeddings(
      db,
      orphans.map((o) => o.note_id),
    );
    deleted += ids.length;
    if (orphans.length < STALE_SCAN) return deleted;
  }
}

/** Removes every vector of a space (semantic search switched off). */
export async function purgeSpace(db: D1Database, sem: Semantic, spaceId: string): Promise<number> {
  let deleted = 0;
  for (;;) {
    const rows = await spaceEmbeddings(db, spaceId, STALE_SCAN);
    if (rows.length === 0) return deleted;
    const ids = rows.flatMap((o) => chunkVectorIds(o.note_id, 0, o.chunk_count));
    if (ids.length) await sem.vectors.deleteByIds(ids);
    await deleteEmbeddings(
      db,
      rows.map((r) => r.note_id),
    );
    deleted += ids.length;
  }
}

/**
 * Embeds stale notes of one space, whole notes at a time, up to `maxChunks` chunks. A single note
 * bigger than the cap is still embedded when it comes first, so the queue always makes progress.
 */
export async function embedSpace(
  db: D1Database,
  sem: Semantic,
  spaceId: string,
  opts: { maxChunks: number; noteIds?: string[] | undefined },
): Promise<EmbedRunResult> {
  const deletedOrphans = await purgeOrphans(db, sem, spaceId);
  const result: EmbedRunResult = {
    notes: 0,
    chunks: 0,
    deletedVectors: deletedOrphans,
    remaining: false,
  };
  if (opts.maxChunks <= 0) return result;
  if (opts.noteIds && opts.noteIds.length === 0) return result;

  const model = sem.embedder.model;
  const stale = await staleNotes(db, spaceId, model, { noteIds: opts.noteIds, limit: STALE_SCAN });
  if (stale.length === 0) return result;
  const counts = await chunkCounts(
    db,
    stale.map((n) => n.id),
  );

  const picked: typeof stale = [];
  let budget = 0;
  for (const n of stale) {
    const c = counts.get(n.id) ?? 0;
    if (picked.length > 0 && budget + c > opts.maxChunks) break;
    picked.push(n);
    budget += c;
  }
  result.remaining = picked.length < stale.length;

  const chunks = await chunksForEmbedding(
    db,
    picked.map((n) => n.id),
  );
  const values = chunks.length ? await sem.embedder.embed(chunks.map(embeddingText)) : [];
  const vectors: ChunkVector[] = chunks.map((c, i) => ({
    id: c.chunk_id,
    values: values[i] ?? [],
    metadata: {
      space_id: c.space_id,
      note_id: c.note_id,
      type: c.type,
      ...(c.project_slug ? { project: c.project_slug } : {}),
    },
  }));
  if (vectors.length) await sem.vectors.upsert(vectors);

  // Bookkeeping: new chunk count per note, and delete vectors for chunks that disappeared.
  const byNote = new Map<string, { hash: string; count: number }>();
  for (const c of chunks) {
    const e = byNote.get(c.note_id) ?? { hash: c.content_hash, count: 0 };
    e.count = Math.max(e.count, c.ord + 1);
    byNote.set(c.note_id, e);
  }
  const surplus: string[] = [];
  const records: EmbeddingRecord[] = picked.map((n) => {
    const e = byNote.get(n.id) ?? { hash: n.content_hash, count: 0 };
    if (n.old_count > e.count) surplus.push(...chunkVectorIds(n.id, e.count, n.old_count));
    return { noteId: n.id, spaceId, contentHash: e.hash, model, chunkCount: e.count };
  });
  if (surplus.length) await sem.vectors.deleteByIds(surplus);
  await recordEmbeddings(db, records);

  result.notes = picked.length;
  result.chunks = chunks.length;
  result.deletedVectors += surplus.length;
  return result;
}

function logFailure(job: string, spaceId: string | null, err: unknown): void {
  // Never log note content or queries (NFR-09): job, space and the error class only.
  console.error(
    JSON.stringify({
      level: 'error',
      job,
      space: spaceId,
      error: err instanceof Error ? err.name : 'unknown',
      message: err instanceof Error ? err.message.slice(0, 200) : undefined,
    }),
  );
}

/**
 * Called after the index changed for a space (save, write, import, sync). Embeds only the touched
 * notes that changed, and purges vectors of deleted ones, after the response.
 */
export function scheduleEmbedding(
  env: Env,
  space: SpaceRow,
  changes: { upserts: string[]; deletes: string[] },
  sem: Semantic | null = semanticFor(env),
): void {
  if (space.semantic_enabled !== 1 || !sem) return;
  if (changes.upserts.length === 0 && changes.deletes.length === 0) return;
  defer(
    (async () => {
      try {
        const noteIds = await Promise.all(changes.upserts.map((p) => noteId(space.id, p)));
        await embedSpace(env.DB, sem, space.id, { maxChunks: POST_WRITE_CHUNK_CAP, noteIds });
      } catch (err) {
        logFailure('embed.after-write', space.id, err);
      }
    })(),
  );
}

/**
 * Same as `scheduleEmbedding` for callers that only know the space id (GitHub sync). `paths` are
 * the re-indexed paths; null after a full rebuild, which scans the whole space for changed hashes.
 */
export function scheduleSpaceEmbedding(
  env: Env,
  spaceId: string,
  paths: string[] | null,
  sem: Semantic | null = semanticFor(env),
): void {
  if (!sem) return;
  defer(
    (async () => {
      try {
        const row = await env.DB.prepare('SELECT semantic_enabled FROM spaces WHERE id = ?')
          .bind(spaceId)
          .first<{ semantic_enabled: number }>();
        if (row?.semantic_enabled !== 1) return;
        const noteIds = paths ? await Promise.all(paths.map((p) => noteId(spaceId, p))) : undefined;
        await embedSpace(env.DB, sem, spaceId, { maxChunks: POST_WRITE_CHUNK_CAP, noteIds });
      } catch (err) {
        logFailure('embed.after-sync', spaceId, err);
      }
    })(),
  );
}

/** Switches semantic search on or off for a space; on starts a backfill, off removes its vectors. */
export async function setSemanticEnabled(
  env: Env,
  space: SpaceRow,
  enabled: boolean,
  sem: Semantic | null = semanticFor(env),
): Promise<SpaceRow> {
  await env.DB.prepare('UPDATE spaces SET semantic_enabled = ?1 WHERE id = ?2')
    .bind(enabled ? 1 : 0, space.id)
    .run();
  const updated: SpaceRow = { ...space, semantic_enabled: enabled ? 1 : 0 };
  const changed = (space.semantic_enabled === 1) !== enabled;
  if (changed && sem) {
    defer(
      (async () => {
        try {
          if (enabled) await embedSpace(env.DB, sem, space.id, { maxChunks: BACKFILL_CHUNK_CAP });
          else await purgeSpace(env.DB, sem, space.id);
        } catch (err) {
          logFailure(enabled ? 'embed.backfill' : 'embed.purge', space.id, err);
        }
      })(),
    );
  }
  return updated;
}

export interface CatchUpResult {
  status: 'ran' | 'unavailable';
  spaces: number;
  notes: number;
  chunks: number;
  deletedVectors: number;
  remaining: boolean;
}

/**
 * Nightly catch-up (Cron): embeds stale or missing notes of every semantic-enabled space, with one
 * chunk cap shared by the whole run (default 200), and removes vectors of deleted notes.
 */
export async function embedCatchUp(
  env: Env,
  opts: { maxChunks?: number; semantic?: Semantic | null } = {},
): Promise<CatchUpResult> {
  const sem = opts.semantic !== undefined ? opts.semantic : semanticFor(env);
  const configured = Number.parseInt(env.SEMANTIC_CRON_CHUNK_CAP ?? '', 10);
  const cap =
    opts.maxChunks ??
    (Number.isFinite(configured) && configured >= 0 ? configured : CRON_CHUNK_CAP);
  const out: CatchUpResult = {
    status: sem ? 'ran' : 'unavailable',
    spaces: 0,
    notes: 0,
    chunks: 0,
    deletedVectors: 0,
    remaining: false,
  };
  if (!sem) return out;

  const spaces = await env.DB.prepare(
    'SELECT id FROM spaces WHERE semantic_enabled = 1 ORDER BY created_at, id',
  ).all<{ id: string }>();
  for (const { id } of spaces.results) {
    out.spaces += 1;
    try {
      const r = await embedSpace(env.DB, sem, id, { maxChunks: cap - out.chunks });
      out.notes += r.notes;
      out.chunks += r.chunks;
      out.deletedVectors += r.deletedVectors;
      if (r.remaining) out.remaining = true;
    } catch (err) {
      logFailure('embed.catch-up', id, err);
    }
  }
  return out;
}
