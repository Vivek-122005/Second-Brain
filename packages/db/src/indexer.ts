import {
  chunkNote,
  extractWikilinks,
  noteTitle,
  parseDecisionLog,
  parseNote,
  projectSlugFromPath,
  resolveLink,
  sha256Hex,
  typeFromPath,
} from '@second-brain/core';
import type { NoteType } from '@second-brain/schema';

/**
 * Turns vault files into index rows (notes, chunks, FTS, links, decisions) — ADR-0003.
 *
 * D1 caps statements per invocation and bound parameters per statement, so every write here is
 * set-based: rows travel as one JSON parameter and are expanded with `json_each`. Indexing a batch
 * of notes costs a constant ~10 statements regardless of how many notes or chunks it contains,
 * and runs as one D1 batch (a single transaction): a note's old rows are replaced atomically.
 */

export interface VaultFile {
  path: string;
  content: string;
}

export interface NoteRecord {
  id: string;
  path: string;
  type: NoteType;
  title: string;
  projectSlug: string | null;
  tags: string[];
  frontmatter: Record<string, unknown>;
  body: string;
  raw: string;
  contentHash: string;
  chunks: { id: string; ord: number; headingPath: string; body: string; tokenCount: number }[];
  links: { target: string; dstPath: string | null }[];
  decisions: {
    id: string;
    title: string;
    rationale: string;
    date: string;
    status: string;
    supersedes: string | null;
    supersededBy: string | null;
  }[];
}

const NOTE_TYPES: readonly string[] = ['project', 'decision-log', 'topic', 'session', 'note'];

/** Deterministic note id so chunks can reference it before the row exists. */
export async function noteId(spaceId: string, path: string): Promise<string> {
  return `not_${(await sha256Hex(`${spaceId}\n${path}`)).slice(0, 26)}`;
}

/** Project a note belongs to: frontmatter `project: [[projects/x]]`, or its own folder. */
function projectOf(path: string, type: NoteType, fm: Record<string, unknown>): string | null {
  if (type === 'project') return path.replace(/^projects\//, '').replace(/\.md$/, '');
  const fromPath = projectSlugFromPath(path);
  if (fromPath) return fromPath;
  const p = fm.project;
  if (typeof p === 'string') {
    const m =
      /^\[\[(?:projects\/)?([^\]|#]+)/.exec(p.trim()) ??
      /^(?:projects\/)?([a-z0-9-]+)$/.exec(p.trim());
    if (m?.[1]) return m[1].replace(/\.md$/, '');
  }
  return null;
}

function tagsOf(fm: Record<string, unknown>): string[] {
  const t = fm.tags;
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === 'string');
  if (typeof t === 'string') return t.split(/[,\s]+/).filter(Boolean);
  return [];
}

/** Builds every index row for one file. Pure apart from hashing. */
export async function buildNoteRecord(
  spaceId: string,
  file: VaultFile,
  knownPaths: Iterable<string>,
): Promise<NoteRecord> {
  const { frontmatter, body } = parseNote(file.content);
  const fmType = typeof frontmatter.type === 'string' ? frontmatter.type : '';
  const type = (NOTE_TYPES.includes(fmType) ? fmType : typeFromPath(file.path)) as NoteType;
  const title = noteTitle(file.path, frontmatter, body);
  const id = await noteId(spaceId, file.path);
  const projectSlug = projectOf(file.path, type, frontmatter);

  const chunks = chunkNote(title, body).map((c) => ({
    id: `${id}:${c.ord}`,
    ord: c.ord,
    headingPath: c.headingPath.join(' > '),
    body: c.body,
    tokenCount: c.tokenCount,
  }));

  const known = [...knownPaths];
  const seen = new Set<string>();
  const links: NoteRecord['links'] = [];
  for (const l of extractWikilinks(body)) {
    if (seen.has(l.target)) continue;
    seen.add(l.target);
    links.push({ target: l.target, dstPath: resolveLink(l.target, known) });
  }

  const decisions =
    type === 'decision-log'
      ? parseDecisionLog(body).map((d) => ({
          id: d.id,
          title: d.title,
          rationale: d.rationale,
          date: d.date,
          status: d.status,
          supersedes: d.supersedes ?? null,
          supersededBy: d.supersededBy ?? null,
        }))
      : [];

  return {
    id,
    path: file.path,
    type,
    title,
    projectSlug,
    tags: tagsOf(frontmatter),
    frontmatter,
    body,
    raw: file.content,
    contentHash: await sha256Hex(file.content),
    chunks,
    links,
    decisions,
  };
}

export async function knownNotePaths(db: D1Database, spaceId: string): Promise<string[]> {
  const r = await db
    .prepare('SELECT path FROM notes WHERE space_id = ?')
    .bind(spaceId)
    .all<{ path: string }>();
  return r.results.map((x) => x.path);
}

export interface IndexOptions {
  /** Vault commit these files come from. */
  sha: string | null;
  generation: number;
  now?: number;
}

/** Statements that atomically replace the index rows for `records`. */
export function indexStatements(
  db: D1Database,
  spaceId: string,
  records: NoteRecord[],
  opts: IndexOptions,
): D1PreparedStatement[] {
  if (records.length === 0) return [];
  const now = opts.now ?? Date.now();
  const ids = JSON.stringify(records.map((r) => r.id));

  const notes = JSON.stringify(
    records.map((r) => ({
      id: r.id,
      path: r.path,
      type: r.type,
      title: r.title,
      project: r.projectSlug,
      tags: JSON.stringify(r.tags),
      fm: JSON.stringify(r.frontmatter),
      body: r.body,
      raw: r.raw,
      hash: r.contentHash,
    })),
  );
  const chunks = JSON.stringify(
    records.flatMap((r) =>
      r.chunks.map((c) => ({
        id: c.id,
        note: r.id,
        ord: c.ord,
        hp: c.headingPath,
        body: c.body,
        tok: c.tokenCount,
        title: r.title,
      })),
    ),
  );
  const links = JSON.stringify(
    records.flatMap((r) => r.links.map((l) => ({ src: r.id, target: l.target, dst: l.dstPath }))),
  );
  const decisions = JSON.stringify(
    records.flatMap((r) =>
      r.decisions.map((d) => ({
        id: d.id,
        note: r.id,
        project: r.projectSlug,
        title: d.title,
        rationale: d.rationale,
        date: d.date,
        status: d.status,
        supersedes: d.supersedes,
        by: d.supersededBy,
      })),
    ),
  );
  // Link targets that newly created notes satisfy: "topics/x", "topics/x.md" and bare "x".
  const targets = JSON.stringify(
    records.flatMap((r) => {
      const noExt = r.path.replace(/\.md$/, '');
      const base = noExt.split('/').pop() ?? noExt;
      return [
        { t: noExt.toLowerCase(), p: r.path },
        { t: r.path.toLowerCase(), p: r.path },
        { t: base.toLowerCase(), p: r.path },
      ];
    }),
  );

  const inIds = 'SELECT value FROM json_each(?1)';
  return [
    db.prepare(`DELETE FROM chunks_fts WHERE note_id IN (${inIds})`).bind(ids),
    db.prepare(`DELETE FROM chunks WHERE note_id IN (${inIds})`).bind(ids),
    db.prepare(`DELETE FROM links WHERE src_note_id IN (${inIds})`).bind(ids),
    db
      .prepare(`DELETE FROM decisions WHERE space_id = ?2 AND note_id IN (${inIds})`)
      .bind(ids, spaceId),
    db
      .prepare(
        `INSERT INTO notes (id, space_id, path, type, title, project_slug, tags, frontmatter, body, raw,
                            content_hash, indexed_sha, generation, updated_at)
         SELECT json_extract(value, '$.id'), ?2, json_extract(value, '$.path'), json_extract(value, '$.type'),
                json_extract(value, '$.title'), json_extract(value, '$.project'), json_extract(value, '$.tags'),
                json_extract(value, '$.fm'), json_extract(value, '$.body'), json_extract(value, '$.raw'),
                json_extract(value, '$.hash'), ?3, ?4, ?5
         FROM json_each(?1)
         WHERE true
         ON CONFLICT (space_id, path) DO UPDATE SET
           type = excluded.type, title = excluded.title, project_slug = excluded.project_slug,
           tags = excluded.tags, frontmatter = excluded.frontmatter, body = excluded.body, raw = excluded.raw,
           content_hash = excluded.content_hash, indexed_sha = excluded.indexed_sha,
           generation = excluded.generation,
           updated_at = CASE WHEN notes.content_hash = excluded.content_hash THEN notes.updated_at
                             ELSE excluded.updated_at END`,
      )
      .bind(notes, spaceId, opts.sha, opts.generation, now),
    db
      .prepare(
        `INSERT INTO chunks (id, note_id, space_id, ord, heading_path, body, token_count)
         SELECT json_extract(value, '$.id'), json_extract(value, '$.note'), ?2, json_extract(value, '$.ord'),
                json_extract(value, '$.hp'), json_extract(value, '$.body'), json_extract(value, '$.tok')
         FROM json_each(?1)`,
      )
      .bind(chunks, spaceId),
    db
      .prepare(
        `INSERT INTO chunks_fts (title, heading_path, body, chunk_id, note_id, space_id)
         SELECT json_extract(value, '$.title'), json_extract(value, '$.hp'), json_extract(value, '$.body'),
                json_extract(value, '$.id'), json_extract(value, '$.note'), ?2
         FROM json_each(?1)`,
      )
      .bind(chunks, spaceId),
    db
      .prepare(
        `INSERT OR REPLACE INTO links (src_note_id, space_id, target, dst_path)
         SELECT json_extract(value, '$.src'), ?2, json_extract(value, '$.target'), json_extract(value, '$.dst')
         FROM json_each(?1)`,
      )
      .bind(links, spaceId),
    db
      .prepare(
        `INSERT OR REPLACE INTO decisions (space_id, id, note_id, project_slug, title, rationale, date, status,
                                           supersedes, superseded_by)
         SELECT ?2, json_extract(value, '$.id'), json_extract(value, '$.note'), json_extract(value, '$.project'),
                json_extract(value, '$.title'), json_extract(value, '$.rationale'), json_extract(value, '$.date'),
                json_extract(value, '$.status'), json_extract(value, '$.supersedes'), json_extract(value, '$.by')
         FROM json_each(?1)`,
      )
      .bind(decisions, spaceId),
    // Repair links that were broken until one of these notes existed.
    db
      .prepare(
        `UPDATE links SET dst_path = (
           SELECT json_extract(t.value, '$.p') FROM json_each(?1) t
           WHERE json_extract(t.value, '$.t') = lower(links.target) LIMIT 1)
         WHERE space_id = ?2 AND dst_path IS NULL
           AND lower(target) IN (SELECT json_extract(value, '$.t') FROM json_each(?1))`,
      )
      .bind(targets, spaceId),
    db
      .prepare(
        `INSERT INTO sync_state (space_id, last_indexed_sha, generation) VALUES (?1, ?2, ?3)
         ON CONFLICT (space_id) DO UPDATE SET
           last_indexed_sha = COALESCE(excluded.last_indexed_sha, sync_state.last_indexed_sha),
           generation = MAX(sync_state.generation, excluded.generation)`,
      )
      .bind(spaceId, opts.sha, opts.generation),
  ];
}

/** Statements that remove notes (and their rows) by path. */
export function removeStatements(
  db: D1Database,
  spaceId: string,
  paths: string[],
): D1PreparedStatement[] {
  if (paths.length === 0) return [];
  const p = JSON.stringify(paths);
  const ids = `SELECT id FROM notes WHERE space_id = ?2 AND path IN (SELECT value FROM json_each(?1))`;
  return [
    db.prepare(`DELETE FROM chunks_fts WHERE note_id IN (${ids})`).bind(p, spaceId),
    db.prepare(`DELETE FROM chunks WHERE note_id IN (${ids})`).bind(p, spaceId),
    db.prepare(`DELETE FROM links WHERE src_note_id IN (${ids})`).bind(p, spaceId),
    db
      .prepare(`DELETE FROM decisions WHERE space_id = ?2 AND note_id IN (${ids})`)
      .bind(p, spaceId),
    db
      .prepare(
        `UPDATE links SET dst_path = NULL WHERE space_id = ?2 AND dst_path IN (SELECT value FROM json_each(?1))`,
      )
      .bind(p, spaceId),
    db
      .prepare(
        `DELETE FROM notes WHERE space_id = ?2 AND path IN (SELECT value FROM json_each(?1))`,
      )
      .bind(p, spaceId),
  ];
}

export async function currentGeneration(db: D1Database, spaceId: string): Promise<number> {
  const row = await db
    .prepare('SELECT generation FROM sync_state WHERE space_id = ?')
    .bind(spaceId)
    .first<{ generation: number }>();
  return row?.generation ?? 0;
}

const BATCH_NOTES = 40;

/**
 * Indexes changed files and removes deleted ones (webhook fast path and immediate post-write
 * update). Only Markdown files are indexed; hidden folders (`.brain/`, `.obsidian/`) are skipped.
 */
export async function applyChanges(
  db: D1Database,
  spaceId: string,
  changes: { upserts: VaultFile[]; deletes: string[] },
  sha: string | null,
): Promise<{ indexed: number; removed: number }> {
  const upserts = changes.upserts.filter((f) => isIndexable(f.path));
  const deletes = changes.deletes.filter(isIndexable);
  const generation = await currentGeneration(db, spaceId);
  const known = new Set(await knownNotePaths(db, spaceId));
  for (const f of upserts) known.add(f.path);
  for (const d of deletes) known.delete(d);

  if (deletes.length) await db.batch(removeStatements(db, spaceId, deletes));
  for (let i = 0; i < upserts.length; i += BATCH_NOTES) {
    const slice = upserts.slice(i, i + BATCH_NOTES);
    const records = await Promise.all(slice.map((f) => buildNoteRecord(spaceId, f, known)));
    await db.batch(indexStatements(db, spaceId, records, { sha, generation }));
  }
  return { indexed: upserts.length, removed: deletes.length };
}

/**
 * Full rebuild (HLD §4.4, NFR-04): write every note with a new generation, then delete rows from
 * older generations. The old index stays queryable until the new one is complete; a failure
 * midway leaves it intact.
 */
export async function rebuildIndex(
  db: D1Database,
  spaceId: string,
  files: VaultFile[],
  sha: string | null,
): Promise<{ indexed: number; removed: number; generation: number }> {
  const indexable = files.filter((f) => isIndexable(f.path));
  const generation = (await currentGeneration(db, spaceId)) + 1;
  const known = new Set(indexable.map((f) => f.path));

  for (let i = 0; i < indexable.length; i += BATCH_NOTES) {
    const slice = indexable.slice(i, i + BATCH_NOTES);
    const records = await Promise.all(slice.map((f) => buildNoteRecord(spaceId, f, known)));
    await db.batch(indexStatements(db, spaceId, records, { sha, generation }));
  }

  const stale = await db
    .prepare('SELECT path FROM notes WHERE space_id = ? AND generation < ?')
    .bind(spaceId, generation)
    .all<{ path: string }>();
  const stalePaths = stale.results.map((r) => r.path);
  if (stalePaths.length) await db.batch(removeStatements(db, spaceId, stalePaths));

  await db
    .prepare(
      `INSERT INTO sync_state (space_id, last_indexed_sha, last_full_rebuild, generation) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (space_id) DO UPDATE SET last_indexed_sha = ?2, last_full_rebuild = ?3, generation = ?4`,
    )
    .bind(spaceId, sha, Date.now(), generation)
    .run();
  return { indexed: indexable.length, removed: stalePaths.length, generation };
}

export function isIndexable(path: string): boolean {
  return /\.md$/i.test(path) && !path.split('/').some((s) => s.startsWith('.'));
}
