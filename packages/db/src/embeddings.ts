import type { NoteType } from '@second-brain/schema';
import { IN_SCOPE } from './queries';

/**
 * Bookkeeping for the optional semantic layer (ADR-0004, FR-SRC-06): which notes are embedded,
 * with which model and content hash, and how many chunk vectors each one has in the vector index.
 * The vectors themselves live outside D1 (Vectorize); this table is what keeps them in step.
 */

export interface StaleNote {
  id: string;
  content_hash: string;
  /** Vectors currently stored for this note (0 when never embedded). */
  old_count: number;
}

/**
 * Notes in a space that need (re-)embedding: never embedded, content changed, or embedded with a
 * different model. Newest first, so recent work becomes searchable before the long tail.
 */
export async function staleNotes(
  db: D1Database,
  spaceId: string,
  model: string,
  opts: { noteIds?: string[] | undefined; limit: number },
): Promise<StaleNote[]> {
  const r = await db
    .prepare(
      `SELECT n.id, n.content_hash, COALESCE(m.chunk_count, 0) AS old_count
       FROM notes n LEFT JOIN embeddings_meta m ON m.note_id = n.id
       WHERE n.space_id = ?1
         AND (?2 IS NULL OR n.id IN (SELECT value FROM json_each(?2)))
         AND (m.note_id IS NULL OR m.content_hash != n.content_hash OR m.model != ?3)
       ORDER BY n.updated_at DESC, n.id
       LIMIT ?4`,
    )
    .bind(spaceId, opts.noteIds ? JSON.stringify(opts.noteIds) : null, model, opts.limit)
    .all<StaleNote>();
  return r.results;
}

/** Number of chunks per note, to fit whole notes under a per-run cap before loading bodies. */
export async function chunkCounts(db: D1Database, noteIds: string[]): Promise<Map<string, number>> {
  if (noteIds.length === 0) return new Map();
  const r = await db
    .prepare(
      `SELECT note_id, COUNT(*) AS n FROM chunks
       WHERE note_id IN (SELECT value FROM json_each(?1)) GROUP BY note_id`,
    )
    .bind(JSON.stringify(noteIds))
    .all<{ note_id: string; n: number }>();
  return new Map(r.results.map((x) => [x.note_id, x.n]));
}

export interface ChunkForEmbedding {
  note_id: string;
  space_id: string;
  content_hash: string;
  title: string;
  type: NoteType;
  project_slug: string | null;
  chunk_id: string;
  ord: number;
  heading_path: string;
  body: string;
}

/**
 * Chunks of the given notes with their note's current hash, read in one statement so the hash
 * recorded afterwards always matches the text that was embedded.
 */
export async function chunksForEmbedding(
  db: D1Database,
  noteIds: string[],
): Promise<ChunkForEmbedding[]> {
  if (noteIds.length === 0) return [];
  const r = await db
    .prepare(
      `SELECT c.note_id, n.space_id, n.content_hash, n.title, n.type, n.project_slug,
              c.id AS chunk_id, c.ord, c.heading_path, c.body
       FROM chunks c JOIN notes n ON n.id = c.note_id
       WHERE c.note_id IN (SELECT value FROM json_each(?1))
       ORDER BY c.note_id, c.ord`,
    )
    .bind(JSON.stringify(noteIds))
    .all<ChunkForEmbedding>();
  return r.results;
}

export interface EmbeddingRecord {
  noteId: string;
  spaceId: string;
  contentHash: string;
  model: string;
  chunkCount: number;
}

export async function recordEmbeddings(
  db: D1Database,
  rows: EmbeddingRecord[],
  now = Date.now(),
): Promise<void> {
  if (rows.length === 0) return;
  await db
    .prepare(
      `INSERT INTO embeddings_meta (note_id, space_id, content_hash, model, chunk_count, embedded_at)
       SELECT json_extract(value, '$.n'), json_extract(value, '$.s'), json_extract(value, '$.h'),
              json_extract(value, '$.m'), json_extract(value, '$.c'), ?2
       FROM json_each(?1)
       WHERE true
       ON CONFLICT (note_id) DO UPDATE SET
         space_id = excluded.space_id, content_hash = excluded.content_hash, model = excluded.model,
         chunk_count = excluded.chunk_count, embedded_at = excluded.embedded_at`,
    )
    .bind(
      JSON.stringify(
        rows.map((r) => ({
          n: r.noteId,
          s: r.spaceId,
          h: r.contentHash,
          m: r.model,
          c: r.chunkCount,
        })),
      ),
      now,
    )
    .run();
}

/** Embedding rows whose note no longer exists in the index (removed, renamed or rebuilt away). */
export async function orphanedEmbeddings(
  db: D1Database,
  spaceId: string,
  limit: number,
): Promise<{ note_id: string; chunk_count: number }[]> {
  const r = await db
    .prepare(
      `SELECT m.note_id, m.chunk_count FROM embeddings_meta m
       LEFT JOIN notes n ON n.id = m.note_id
       WHERE m.space_id = ?1 AND n.id IS NULL
       LIMIT ?2`,
    )
    .bind(spaceId, limit)
    .all<{ note_id: string; chunk_count: number }>();
  return r.results;
}

/** Every embedding row of a space (used when semantic search is switched off). */
export async function spaceEmbeddings(
  db: D1Database,
  spaceId: string,
  limit: number,
): Promise<{ note_id: string; chunk_count: number }[]> {
  const r = await db
    .prepare('SELECT note_id, chunk_count FROM embeddings_meta WHERE space_id = ?1 LIMIT ?2')
    .bind(spaceId, limit)
    .all<{ note_id: string; chunk_count: number }>();
  return r.results;
}

export async function deleteEmbeddings(db: D1Database, noteIds: string[]): Promise<void> {
  if (noteIds.length === 0) return;
  await db
    .prepare('DELETE FROM embeddings_meta WHERE note_id IN (SELECT value FROM json_each(?1))')
    .bind(JSON.stringify(noteIds))
    .run();
}

export interface ChunkHitRow {
  chunk_id: string;
  space_id: string;
  path: string;
  title: string;
  type: string;
  heading: string;
  body: string;
}

/**
 * Resolves vector hits (chunk ids) back to notes **with the same permission filter as keyword
 * search** (FR-SRC-03): the caller's read scope (`IN_SCOPE`, so `space_id:project` tokens from
 * project-level grants only match that project), project scope, type filter and session
 * exclusion. A vector that points outside what the caller may read, or at a chunk that no longer
 * exists, is simply not returned.
 */
export async function chunkHits(
  db: D1Database,
  opts: {
    /** Read scope tokens: a space id, or `space_id:project` for a project-level grant. */
    spaceIds: string[];
    chunkIds: string[];
    project?: string | undefined;
    types?: NoteType[] | undefined;
    includeSessions?: boolean | undefined;
  },
): Promise<ChunkHitRow[]> {
  if (opts.chunkIds.length === 0 || opts.spaceIds.length === 0) return [];
  const types = opts.types?.length ? opts.types : null;
  const excludeSessions = !opts.includeSessions && !(types?.includes('session') ?? false);
  const r = await db
    .prepare(
      `SELECT c.id AS chunk_id, n.space_id, n.path, n.title, n.type, c.heading_path AS heading,
              c.body
       FROM chunks c JOIN notes n ON n.id = c.note_id
       WHERE c.id IN (SELECT value FROM json_each(?1))
         AND c.space_id = n.space_id
         AND ${IN_SCOPE(2, 'n.')}
         AND (?3 IS NULL OR n.project_slug = ?3)
         AND (?4 IS NULL OR n.type IN (SELECT value FROM json_each(?4)))
         AND (?5 = 0 OR n.type != 'session')`,
    )
    .bind(
      JSON.stringify(opts.chunkIds),
      JSON.stringify(opts.spaceIds),
      opts.project ?? null,
      types ? JSON.stringify(types) : null,
      excludeSessions ? 1 : 0,
    )
    .all<ChunkHitRow>();
  return r.results;
}
