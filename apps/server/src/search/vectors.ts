import type { NoteType } from '@second-brain/schema';

/**
 * Chunk vectors in Cloudflare Vectorize (ADR-0004). One vector per chunk; the vector id is the
 * chunk id (`<note_id>:<ord>`), which is stable across re-indexing, so re-embedding a note
 * overwrites its vectors in place. Metadata carries what search filters on (`space_id`, `project`,
 * `type`) plus `note_id`; each filtered property needs a metadata index (docs/runbooks/deploy.md).
 *
 * Metadata filtering narrows candidates, but it is not the security boundary: every hit is
 * re-checked against D1 with the caller's readable spaces before it is returned.
 */

export interface ChunkVector {
  id: string;
  values: number[];
  metadata: { space_id: string; note_id: string; type: string; project?: string };
}

export interface VectorQuery {
  topK: number;
  /** Only vectors from these spaces are considered. Must be non-empty. */
  spaceIds: string[];
  project?: string | undefined;
  types?: NoteType[] | undefined;
  excludeSessions: boolean;
}

export interface VectorMatch {
  id: string;
  /** Cosine similarity (the index is created with `--metric=cosine`). */
  score: number;
}

export interface VectorIndex {
  upsert(vectors: ChunkVector[]): Promise<void>;
  query(values: number[], q: VectorQuery): Promise<VectorMatch[]>;
  deleteByIds(ids: string[]): Promise<void>;
}

/** Vectorize caps topK at 100 without values/full metadata; 50 is plenty for fusion. */
export const MAX_TOP_K = 50;
const UPSERT_BATCH = 100;
const DELETE_BATCH = 500;

/** Vector ids of a note's chunks with `from <= ord < to`. */
export function chunkVectorIds(noteId: string, from: number, to: number): string[] {
  const ids: string[] = [];
  for (let ord = from; ord < to; ord++) ids.push(`${noteId}:${ord}`);
  return ids;
}

export function vectorFilter(q: VectorQuery): VectorizeVectorMetadataFilter {
  if (q.spaceIds.length === 0) throw new Error('vector query needs at least one space');
  const filter: VectorizeVectorMetadataFilter = { space_id: { $in: q.spaceIds } };
  if (q.project) filter.project = { $eq: q.project };
  if (q.types?.length) filter.type = { $in: q.types };
  else if (q.excludeSessions) filter.type = { $ne: 'session' };
  return filter;
}

export function vectorizeIndex(binding: Vectorize): VectorIndex {
  return {
    async upsert(vectors) {
      for (let i = 0; i < vectors.length; i += UPSERT_BATCH) {
        await binding.upsert(vectors.slice(i, i + UPSERT_BATCH));
      }
    },
    async query(values, q) {
      const res = await binding.query(values, {
        topK: Math.min(Math.max(q.topK, 1), MAX_TOP_K),
        returnValues: false,
        returnMetadata: 'none',
        filter: vectorFilter(q),
      });
      return res.matches.map((m) => ({ id: m.id, score: m.score }));
    },
    async deleteByIds(ids) {
      for (let i = 0; i < ids.length; i += DELETE_BATCH) {
        await binding.deleteByIds(ids.slice(i, i + DELETE_BATCH));
      }
    },
  };
}
