import { chunkHits, searchNotes } from '@second-brain/db';
import type { NoteType, SearchHit, SearchMode, SemanticStatus } from '@second-brain/schema';
import { checkProject, type Principal, spaceFor } from '../auth/principal';
import { readScope, withSource } from '../authz';
import type { Env } from '../env';
import { fuseHits, type ScopedHit, type VectorHit } from './fusion';
import { type Semantic, semanticFor } from './semantic';
import { MAX_TOP_K } from './vectors';

/**
 * Search used by both `brain_search` (MCP) and `GET /api/v1/search` (LLD §4.2, ADR-0004).
 *
 * Keyword (FTS5/BM25) always runs, scoped by `readScope(p)`. In hybrid mode a vector query runs in
 * parallel, pre-filtered by Vectorize metadata to the semantic-enabled spaces in that scope (and the
 * project, when one is asked for). Hits under the similarity floor are dropped. The rest are
 * re-checked in D1 with the **same scope tokens and `IN_SCOPE` predicate as keyword search**, so a
 * project-level grant never exposes other projects of the space through vectors, whatever the
 * vector index returns. Both lists are fused with RRF. Any AI/Vectorize failure (or a missing
 * binding) degrades silently to keyword results with `semantic: "unavailable"`.
 */

export interface SearchRequest {
  query: string;
  types?: NoteType[] | undefined;
  project?: string | undefined;
  /** Search one space only (must be readable by the caller). */
  spaceId?: string | undefined;
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

/** Space id of a scope token (`space_id` or `space_id:project`; space ids never contain `:`). */
const spaceOfToken = (token: string) => token.split(':')[0] ?? token;

async function vectorLeg(
  db: D1Database,
  sem: Semantic,
  req: SearchRequest,
  scope: string[],
  vectorSpaces: string[],
  project: string | undefined,
): Promise<VectorHit[]> {
  const [values] = await sem.embedder.embed([req.query]);
  if (!values) throw new Error('no query embedding');
  const types = req.types?.length ? req.types : undefined;
  const matches = await sem.vectors.query(values, {
    topK: Math.min(req.limit * 4, MAX_TOP_K),
    spaceIds: vectorSpaces,
    project,
    types,
    excludeSessions: !req.includeSessions && !(types?.includes('session') ?? false),
  });
  const scores = new Map(matches.map((m) => [m.id, m.score]));
  // Permission filtering again, from D1, with the caller's scope tokens: the vector index is a
  // candidate generator only, never the permission boundary.
  const rows = await chunkHits(db, {
    spaceIds: scope.filter((t) => vectorSpaces.includes(spaceOfToken(t))),
    chunkIds: matches.map((m) => m.id),
    project,
    types,
    includeSessions: req.includeSessions,
  });
  return rows.map((r) => ({
    space_id: r.space_id,
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
  checkProject(p, req.project);
  const target = req.spaceId ? spaceFor(p, req.spaceId) : null;
  const scope = readScope(p, target ? { spaceId: target.id } : {});
  const project = req.project ?? p.project ?? undefined;
  const present = (hits: ScopedHit[]): SearchHit[] =>
    hits.map(({ space_id, ...h }) => withSource(p, space_id, h));
  const keyword = (limit: number) =>
    searchNotes(env.DB, {
      spaceIds: scope,
      query: req.query,
      types: req.types,
      project,
      includeSessions: req.includeSessions ?? false,
      limit,
    });

  const inScope = new Set(scope.map(spaceOfToken));
  const vectorSpaces = p.spaces
    .filter((s) => inScope.has(s.id) && s.semantic_enabled === 1)
    .map((s) => s.id);
  const hybrid = (req.mode ?? (vectorSpaces.length ? 'hybrid' : 'keyword')) === 'hybrid';
  if (!hybrid || vectorSpaces.length === 0) {
    return { hits: present(await keyword(req.limit)), mode: 'keyword', semantic: 'disabled' };
  }

  const sem = opts.semantic !== undefined ? opts.semantic : semanticFor(env);
  if (!sem) {
    return { hits: present(await keyword(req.limit)), mode: 'keyword', semantic: 'unavailable' };
  }

  const [kw, vec] = await Promise.all([
    keyword(req.limit * 2),
    withTimeout(vectorLeg(env.DB, sem, req, scope, vectorSpaces, project), VECTOR_TIMEOUT_MS).catch(
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
    return { hits: present(kw.slice(0, req.limit)), mode: 'keyword', semantic: 'unavailable' };
  }
  return {
    hits: present(fuseHits(kw, vec, { limit: req.limit })),
    mode: 'hybrid',
    semantic: 'used',
  };
}
