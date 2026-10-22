import { chunkHits, searchNotes } from '@second-brain/db';
import type { NoteType, SearchHit, SearchMode, SemanticStatus } from '@second-brain/schema';
import type { Principal } from '../auth/principal';
import type { Env } from '../env';
import { fuseHits, type VectorHit } from './fusion';
import { type Semantic, semanticFor } from './semantic';
import { MAX_TOP_K } from './vectors';

/**
 * Search used by both `brain_search` (MCP) and `GET /api/v1/search` (LLD §4.2, ADR-0004).
 *
 * Keyword (FTS5/BM25) always runs. In hybrid mode a vector query runs in parallel, restricted by
 * Vectorize metadata to the caller's semantic-enabled spaces (and project), hits under the
 * similarity floor are dropped, the rest are re-checked against D1 with the same permission filter
 * as keyword search, and both lists are fused with RRF. Any AI/Vectorize failure (or a missing
 * binding) degrades silently to keyword results with `semantic: "unavailable"`.
 */

export interface SearchRequest {
  query: string;
  types?: NoteType[] | undefined;
  project?: string | undefined;
  includeSessions?: boolean | undefined;
  limit: number;
  /** Omitted: hybrid when semantic search is on for a searched space, else keyword. */
  mode?: SearchMode | undefined;
}

export interface SearchResult {
  hits: SearchHit[];
  mode: 'keyword' | 'hybrid';
  semantic: SemanticStatus;
}

/** Upper bound on the vector leg so a slow index never holds a search hostage. */
export const VECTOR_TIMEOUT_MS = 3000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('vector search timed out')), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

async function vectorLeg(
  db: D1Database,
  sem: Semantic,
  req: SearchRequest,
  spaceIds: string[],
  project: string | undefined,
): Promise<VectorHit[]> {
  const [values] = await sem.embedder.embed([req.query]);
  if (!values) throw new Error('no query embedding');
  const types = req.types?.length ? req.types : undefined;
  const matches = await sem.vectors.query(values, {
    topK: Math.min(req.limit * 4, MAX_TOP_K),
    spaceIds,
    project,
    types,
    excludeSessions: !req.includeSessions && !(types?.includes('session') ?? false),
  });
  const scores = new Map(matches.map((m) => [m.id, m.score]));
  // Permission filtering again, from D1: only chunks in these spaces (and scope) come back.
  const rows = await chunkHits(db, {
    spaceIds,
    chunkIds: matches.map((m) => m.id),
    project,
    types,
    includeSessions: req.includeSessions,
  });
  return rows.map((r) => ({
    path: r.path,
    title: r.title,
    type: r.type,
    heading: r.heading,
    body: r.body,
    score: scores.get(r.chunk_id) ?? 0,
  }));
}

export async function searchMemory(
  env: Env,
  p: Principal,
  req: SearchRequest,
  opts: { semantic?: Semantic | null } = {},
): Promise<SearchResult> {
  const spaceIds = p.spaces.map((s) => s.id);
  const project = req.project ?? p.project ?? undefined;
  const keyword = (limit: number) =>
    searchNotes(env.DB, {
      spaceIds,
      query: req.query,
      types: req.types,
      project,
      includeSessions: req.includeSessions ?? false,
      limit,
    });

  const semanticSpaces = p.spaces.filter((s) => s.semantic_enabled === 1).map((s) => s.id);
  const hybrid = (req.mode ?? (semanticSpaces.length ? 'hybrid' : 'keyword')) === 'hybrid';
  if (!hybrid || semanticSpaces.length === 0) {
    return { hits: await keyword(req.limit), mode: 'keyword', semantic: 'disabled' };
  }

  const sem = opts.semantic !== undefined ? opts.semantic : semanticFor(env);
  if (!sem) return { hits: await keyword(req.limit), mode: 'keyword', semantic: 'unavailable' };

  const [kw, vec] = await Promise.all([
    keyword(req.limit * 2),
    withTimeout(vectorLeg(env.DB, sem, req, semanticSpaces, project), VECTOR_TIMEOUT_MS).catch(
      (err: unknown) => {
        console.error(
          JSON.stringify({
            level: 'warn',
            job: 'search.vector',
            error: err instanceof Error ? err.name : 'unknown',
          }),
        );
        return null;
      },
    ),
  ]);
  if (vec === null) {
    return { hits: kw.slice(0, req.limit), mode: 'keyword', semantic: 'unavailable' };
  }
  return { hits: fuseHits(kw, vec, { limit: req.limit }), mode: 'hybrid', semantic: 'used' };
}
