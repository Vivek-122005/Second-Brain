import { sanitizeFtsQuery } from '@second-brain/core';
import type { NoteType, ProjectSummary, SearchHit } from '@second-brain/schema';

/**
 * Read-side queries over the index. Every query takes the list of space ids the caller may read
 * and applies it inside SQL (FR-SRC-03), so hidden rows can neither crowd out visible ones nor
 * leak through gaps in the results.
 */

export interface NoteRow {
  id: string;
  space_id: string;
  path: string;
  type: NoteType;
  title: string;
  project_slug: string | null;
  tags: string;
  frontmatter: string;
  body: string;
  raw: string;
  content_hash: string;
  indexed_sha: string | null;
  updated_at: number;
}

const spacesParam = (spaceIds: string[]) => JSON.stringify(spaceIds);
const IN_SPACES = (n: number) => `IN (SELECT value FROM json_each(?${n}))`;

export interface SearchOptions {
  spaceIds: string[];
  query: string;
  types?: NoteType[] | undefined;
  project?: string | undefined;
  includeSessions?: boolean;
  limit: number;
}

/**
 * Keyword search (FR-SRC-02/04/05): sanitised FTS5 query, BM25 weighted title > heading > body,
 * over-fetch ×4, keep the best chunk per note, sessions excluded unless asked for.
 */
export async function searchNotes(db: D1Database, opts: SearchOptions): Promise<SearchHit[]> {
  const match = sanitizeFtsQuery(opts.query);
  if (!match || opts.spaceIds.length === 0) return [];

  const types = opts.types?.length ? opts.types : null;
  const excludeSessions = !opts.includeSessions && !(types?.includes('session') ?? false);

  const rows = await db
    .prepare(
      `SELECT n.path, n.title, n.type, c.heading_path AS heading,
              snippet(chunks_fts, 2, '**', '**', '…', 16) AS snippet,
              bm25(chunks_fts, 5.0, 2.0, 1.0) AS rank
       FROM chunks_fts
       JOIN chunks c ON c.id = chunks_fts.chunk_id
       JOIN notes n ON n.id = c.note_id
       WHERE chunks_fts MATCH ?1
         AND chunks_fts.space_id ${IN_SPACES(2)}
         AND (?3 IS NULL OR n.project_slug = ?3)
         AND (?4 IS NULL OR n.type IN (SELECT value FROM json_each(?4)))
         AND (?5 = 0 OR n.type != 'session')
       ORDER BY rank
       LIMIT ?6`,
    )
    .bind(
      match,
      spacesParam(opts.spaceIds),
      opts.project ?? null,
      types ? JSON.stringify(types) : null,
      excludeSessions ? 1 : 0,
      opts.limit * 4,
    )
    .all<{
      path: string;
      title: string;
      type: string;
      heading: string;
      snippet: string;
      rank: number;
    }>();

  const best = new Map<string, SearchHit>();
  for (const r of rows.results) {
    if (best.has(r.path)) continue; // rows are ordered best-first
    best.set(r.path, {
      path: r.path,
      title: r.title,
      type: r.type,
      heading: r.heading,
      snippet: r.snippet,
      score: Math.round(-r.rank * 1000) / 1000,
    });
    if (best.size >= opts.limit) break;
  }
  return [...best.values()];
}

export async function getNote(
  db: D1Database,
  spaceIds: string[],
  path: string,
): Promise<NoteRow | null> {
  return db
    .prepare(`SELECT * FROM notes WHERE space_id ${IN_SPACES(1)} AND path = ?2 LIMIT 1`)
    .bind(spacesParam(spaceIds), path)
    .first<NoteRow>();
}

export async function getBacklinks(
  db: D1Database,
  spaceId: string,
  path: string,
): Promise<{ path: string; title: string }[]> {
  const r = await db
    .prepare(
      `SELECT DISTINCT n.path, n.title FROM links l JOIN notes n ON n.id = l.src_note_id
       WHERE l.space_id = ?1 AND l.dst_path = ?2 ORDER BY n.title`,
    )
    .bind(spaceId, path)
    .all<{ path: string; title: string }>();
  return r.results;
}

export async function getOutgoingLinks(
  db: D1Database,
  noteId: string,
): Promise<{ target: string; path: string | null }[]> {
  const r = await db
    .prepare('SELECT target, dst_path AS path FROM links WHERE src_note_id = ? ORDER BY target')
    .bind(noteId)
    .all<{ target: string; path: string | null }>();
  return r.results;
}

export interface ListNotesOptions {
  spaceIds: string[];
  type?: NoteType | undefined;
  project?: string | undefined;
  /** Cursor = `updated_at:path` of the last item of the previous page. */
  cursor?: string | undefined;
  limit: number;
}

export async function listNotes(
  db: D1Database,
  opts: ListNotesOptions,
): Promise<{
  items: Pick<NoteRow, 'path' | 'title' | 'type' | 'project_slug' | 'tags' | 'updated_at'>[];
  next: string | null;
}> {
  let cursorAt = Number.MAX_SAFE_INTEGER;
  let cursorPath = '';
  if (opts.cursor) {
    const i = opts.cursor.indexOf(':');
    cursorAt = Number(opts.cursor.slice(0, i));
    cursorPath = opts.cursor.slice(i + 1);
  }
  const r = await db
    .prepare(
      `SELECT path, title, type, project_slug, tags, updated_at FROM notes
       WHERE space_id ${IN_SPACES(1)}
         AND (?2 IS NULL OR type = ?2)
         AND (?3 IS NULL OR project_slug = ?3)
         AND (updated_at < ?4 OR (updated_at = ?4 AND path > ?5))
       ORDER BY updated_at DESC, path ASC
       LIMIT ?6`,
    )
    .bind(
      spacesParam(opts.spaceIds),
      opts.type ?? null,
      opts.project ?? null,
      cursorAt,
      cursorPath,
      opts.limit + 1,
    )
    .all<Pick<NoteRow, 'path' | 'title' | 'type' | 'project_slug' | 'tags' | 'updated_at'>>();
  const items = r.results.slice(0, opts.limit);
  const last = items[items.length - 1];
  const next = r.results.length > opts.limit && last ? `${last.updated_at}:${last.path}` : null;
  return { items, next };
}

export async function listProjects(
  db: D1Database,
  spaceIds: string[],
  status?: string,
): Promise<ProjectSummary[]> {
  const r = await db
    .prepare(
      `SELECT path, title, frontmatter, updated_at FROM notes
       WHERE space_id ${IN_SPACES(1)} AND type = 'project'
       ORDER BY updated_at DESC`,
    )
    .bind(spacesParam(spaceIds))
    .all<{ path: string; title: string; frontmatter: string; updated_at: number }>();
  const out: ProjectSummary[] = [];
  for (const row of r.results) {
    const fm = safeJson(row.frontmatter);
    const st = typeof fm.status === 'string' ? fm.status : 'active';
    if (status && st !== status) continue;
    const next = Array.isArray(fm.next) && typeof fm.next[0] === 'string' ? fm.next[0] : undefined;
    const summary: ProjectSummary = {
      slug: row.path.replace(/^projects\//, '').replace(/\.md$/, ''),
      title: row.title,
      status: st,
      updated:
        typeof fm.updated === 'string'
          ? fm.updated
          : new Date(row.updated_at).toISOString().slice(0, 10),
    };
    if (next) summary.next = next;
    out.push(summary);
  }
  return out;
}

export interface DecisionRow {
  id: string;
  title: string;
  rationale: string;
  date: string;
  status: string;
  project_slug: string | null;
  supersedes: string | null;
  superseded_by: string | null;
  path: string;
}

export async function recentDecisions(
  db: D1Database,
  spaceIds: string[],
  opts: { project?: string | undefined; limit: number; includeSuperseded?: boolean },
): Promise<DecisionRow[]> {
  const r = await db
    .prepare(
      `SELECT d.id, d.title, d.rationale, d.date, d.status, d.project_slug, d.supersedes, d.superseded_by, n.path
       FROM decisions d JOIN notes n ON n.id = d.note_id
       WHERE d.space_id ${IN_SPACES(1)}
         AND (?2 IS NULL OR d.project_slug = ?2 OR d.project_slug IS NULL)
         AND (?3 = 1 OR d.status != 'superseded')
       ORDER BY d.date DESC, d.id DESC
       LIMIT ?4`,
    )
    .bind(spacesParam(spaceIds), opts.project ?? null, opts.includeSuperseded ? 1 : 0, opts.limit)
    .all<DecisionRow>();
  return r.results;
}

export async function maxDecisionNumber(db: D1Database, spaceId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT MAX(CAST(substr(id, 5) AS INTEGER)) AS n FROM decisions WHERE space_id = ?`)
    .bind(spaceId)
    .first<{ n: number | null }>();
  return row?.n ?? 0;
}

export async function decisionLocation(
  db: D1Database,
  spaceId: string,
  id: string,
): Promise<{ path: string } | null> {
  return db
    .prepare(
      `SELECT n.path FROM decisions d JOIN notes n ON n.id = d.note_id WHERE d.space_id = ? AND d.id = ?`,
    )
    .bind(spaceId, id)
    .first<{ path: string }>();
}

export interface SessionNoteRow {
  path: string;
  frontmatter: string;
  updated_at: number;
}

export async function recentSessionNotes(
  db: D1Database,
  spaceIds: string[],
  opts: { project?: string | undefined; limit: number },
): Promise<SessionNoteRow[]> {
  const r = await db
    .prepare(
      `SELECT path, frontmatter, updated_at FROM notes
       WHERE space_id ${IN_SPACES(1)} AND type = 'session' AND (?2 IS NULL OR project_slug = ?2)
       ORDER BY path DESC
       LIMIT ?3`,
    )
    .bind(spacesParam(spaceIds), opts.project ?? null, opts.limit)
    .all<SessionNoteRow>();
  return r.results;
}

export async function graph(
  db: D1Database,
  spaceIds: string[],
): Promise<{
  nodes: { id: string; title: string; type: NoteType }[];
  edges: { source: string; target: string }[];
}> {
  const [nodes, edges] = await db.batch([
    db
      .prepare(
        `SELECT path AS id, title, type FROM notes WHERE space_id ${IN_SPACES(1)} AND type != 'session'`,
      )
      .bind(spacesParam(spaceIds)),
    db
      .prepare(
        `SELECT DISTINCT n.path AS source, l.dst_path AS target FROM links l JOIN notes n ON n.id = l.src_note_id
         WHERE l.space_id ${IN_SPACES(1)} AND l.dst_path IS NOT NULL AND n.type != 'session'`,
      )
      .bind(spacesParam(spaceIds)),
  ]);
  return {
    nodes: (nodes?.results ?? []) as { id: string; title: string; type: NoteType }[],
    edges: (edges?.results ?? []) as { source: string; target: string }[],
  };
}

export async function brokenLinks(
  db: D1Database,
  spaceId: string,
  limit = 50,
): Promise<{ from: string; target: string }[]> {
  const r = await db
    .prepare(
      `SELECT n.path AS "from", l.target FROM links l JOIN notes n ON n.id = l.src_note_id
       WHERE l.space_id = ? AND l.dst_path IS NULL ORDER BY n.path LIMIT ?`,
    )
    .bind(spaceId, limit)
    .all<{ from: string; target: string }>();
  return r.results;
}

export async function topicsForDuplicateCheck(
  db: D1Database,
  spaceId: string,
): Promise<{ path: string; title: string; aliases: string[] }[]> {
  const r = await db
    .prepare(
      `SELECT path, title, frontmatter FROM notes WHERE space_id = ? AND type = 'topic' LIMIT 2000`,
    )
    .bind(spaceId)
    .all<{ path: string; title: string; frontmatter: string }>();
  return r.results.map((t) => {
    const fm = safeJson(t.frontmatter);
    const aliases = Array.isArray(fm.aliases)
      ? fm.aliases.filter((a): a is string => typeof a === 'string')
      : [];
    return { path: t.path, title: t.title, aliases };
  });
}

export async function noteStats(
  db: D1Database,
  spaceIds: string[],
): Promise<{ notes: number; topics: number; decisions: number; sessions: number }> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS notes,
              SUM(CASE WHEN type = 'topic' THEN 1 ELSE 0 END) AS topics,
              SUM(CASE WHEN type = 'session' THEN 1 ELSE 0 END) AS sessions,
              (SELECT COUNT(*) FROM decisions WHERE space_id ${IN_SPACES(1)} AND status != 'superseded') AS decisions
       FROM notes WHERE space_id ${IN_SPACES(1)}`,
    )
    .bind(spacesParam(spaceIds))
    .first<{ notes: number; topics: number | null; decisions: number; sessions: number | null }>();
  return {
    notes: row?.notes ?? 0,
    topics: row?.topics ?? 0,
    decisions: row?.decisions ?? 0,
    sessions: row?.sessions ?? 0,
  };
}

export function safeJson(text: string | null | undefined): Record<string, unknown> {
  if (!text) return {};
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
