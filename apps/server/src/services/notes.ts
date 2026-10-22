import {
  isHeadingAtMost,
  normalizeVaultPath,
  parseHeading,
  redactSecrets,
  sha256Hex,
  truncateToTokens,
} from '@second-brain/core';
import {
  applyChanges,
  getBacklinks,
  getNote,
  getOutgoingLinks,
  type NoteRow,
  safeJson,
  visiblePaths,
} from '@second-brain/db';
import type { ImportResponse, NoteDetail, NoteType, ReadOutput } from '@second-brain/schema';
import { type Principal, spaceFor } from '../auth/principal';
import { authorize, readScope, withSource } from '../authz';
import { authorizeChanges } from '../authz/writes';
import type { Env } from '../env';
import { badRequest, conflict, HttpError, notFound } from '../lib/http';
import { audit } from './audit';
import type { SpaceRow } from './spaces';
import {
  type CommitMeta,
  type FileChange,
  type VaultStore,
  VaultConflictError,
  vaultFor,
} from '../vault';

const MAX_ATTEMPTS = 3;

export function commitMeta(
  p: Principal,
  summary: string,
  extra: Record<string, string> = {},
): CommitMeta {
  const trailers = {
    'Second-Brain-Client': p.client ?? (p.via === 'session' ? 'web' : 'unknown'),
    ...(p.machine ? { 'Second-Brain-Machine': p.machine } : {}),
    ...(p.keyPrefix ? { 'Second-Brain-Key': p.keyPrefix } : {}),
    // Who wrote this, so history in shared spaces shows each collaborator (sharing §5).
    'Second-Brain-Actor': `user:${p.userId}${p.keyId ? ` key:${p.keyId}` : ''}`,
    ...extra,
  };
  const body = Object.entries(trailers)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  return {
    message: `${summary.split('\n')[0]?.slice(0, 72) ?? 'update'}\n\n${body}`,
    author: { name: p.name ?? p.email, email: p.email },
  };
}

/**
 * Builds a change set against the current head and commits it, retrying on a lost race with a
 * fresh read (optimistic concurrency, ADR-0008). After the commit the index is updated at once so
 * the caller can read its own writes; the webhook/nightly paths are idempotent with this.
 */
export async function commitWithRetry<T>(
  env: Env,
  space: SpaceRow,
  build: (
    vault: VaultStore,
    head: string | null,
  ) => Promise<{ changes: FileChange[]; meta: CommitMeta; result: T }>,
): Promise<{ sha: string; result: T; changes: FileChange[] }> {
  const vault = await vaultFor(env, space);
  for (let attempt = 1; ; attempt++) {
    const head = await vault.head();
    const { changes, meta, result } = await build(vault, head);
    try {
      const sha = await vault.commit(changes, meta, head);
      await applyChanges(
        env.DB,
        space.id,
        {
          upserts: changes
            .filter((c) => c.content !== null)
            .map((c) => ({ path: c.path, content: c.content as string })),
          deletes: changes.filter((c) => c.content === null).map((c) => c.path),
        },
        sha,
      );
      return { sha, result, changes };
    } catch (err) {
      if (err instanceof VaultConflictError && attempt < MAX_ATTEMPTS) continue;
      if (err instanceof VaultConflictError)
        throw conflict('The vault kept changing while saving. Try again.');
      throw err;
    }
  }
}

/** Extracts one heading's section (heading line included) from a Markdown body. */
export function extractSection(body: string, section: string): string | null {
  const lines = body.split('\n');
  const want = section.trim().toLowerCase();
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const h = parseHeading(lines[i] ?? '');
    if (h && h.text.toLowerCase() === want) {
      start = i;
      level = h.level;
      break;
    }
  }
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (isHeadingAtMost(lines[i] ?? '', level)) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n').trim();
}

function resolvePath(input: string, forWrite = false): string {
  try {
    return normalizeVaultPath(input, { forWrite });
  } catch (err) {
    throw badRequest(err instanceof Error ? err.message : 'Invalid path');
  }
}

/**
 * Finds a note the caller may read: in `spaceId` when given (e.g. from a search hit's
 * `source.space`), else in their default space first, then anywhere in their read scope.
 */
async function findNote(
  env: Env,
  p: Principal,
  path: string,
  spaceId: string | undefined,
): Promise<NoteRow | null> {
  if (spaceId) return getNote(env.DB, readScope(p, { spaceId: spaceFor(p, spaceId).id }), path);
  return (
    (await getNote(env.DB, readScope(p, { spaceId: p.defaultSpace.id }), path)) ??
    (await getNote(env.DB, readScope(p), path))
  );
}

export async function readNoteForAgent(
  env: Env,
  p: Principal,
  path: string,
  section: string | undefined,
  maxTokens: number,
  spaceId?: string,
): Promise<ReadOutput & { space_id: string }> {
  const clean = resolvePath(path);
  const row = await findNote(env, p, clean, spaceId);
  if (!row) throw notFound(`No note at ${clean}. Use brain_search to find notes.`);
  if (p.project && row.project_slug && row.project_slug !== p.project)
    throw notFound(`No note at ${clean}.`);
  let content = row.body;
  if (section) {
    const s = extractSection(row.body, section);
    if (s === null) throw notFound(`No section "${section}" in ${clean}.`);
    content = s;
  }
  const t = truncateToTokens(content, maxTokens);
  const backlinks = await getBacklinks(
    env.DB,
    row.space_id,
    row.path,
    readScope(p, { spaceId: row.space_id }),
  );
  return withSource(p, row.space_id, {
    space_id: row.space_id,
    path: row.path,
    title: row.title,
    type: row.type,
    frontmatter: safeJson(row.frontmatter),
    content: t.truncated
      ? `${t.text}\n\n[truncated: call brain_read with section or a larger max_tokens]`
      : t.text,
    truncated: t.truncated,
    version: row.content_hash,
    backlinks: backlinks.map((b) => b.path),
  });
}

export async function noteDetail(
  env: Env,
  p: Principal,
  path: string,
  spaceId?: string,
): Promise<NoteDetail> {
  const clean = resolvePath(path);
  const row = await findNote(env, p, clean, spaceId);
  if (!row) throw notFound(`No note at ${clean}.`);
  const scope = readScope(p, { spaceId: row.space_id });
  const [outgoing, backlinks] = await Promise.all([
    getOutgoingLinks(env.DB, row.id),
    getBacklinks(env.DB, row.space_id, row.path, scope),
  ]);
  // With project-level access, links into other projects stay unresolved (no path leak).
  let links = outgoing;
  if (!scope.includes(row.space_id)) {
    const targets = outgoing.flatMap((l) => (l.path ? [l.path] : []));
    const visible = await visiblePaths(env.DB, scope, row.space_id, targets);
    links = outgoing.map((l) => (l.path && !visible.has(l.path) ? { ...l, path: null } : l));
  }
  return withSource(p, row.space_id, {
    path: row.path,
    title: row.title,
    type: row.type as NoteType,
    project: row.project_slug,
    tags: JSON.parse(row.tags) as string[],
    updated_at: new Date(row.updated_at).toISOString(),
    frontmatter: safeJson(row.frontmatter),
    body: row.body,
    raw: row.raw,
    version: row.content_hash,
    links,
    backlinks,
  });
}

/**
 * Writes one whole note (FR-VLT-06). `baseVersion` is the content hash the caller last read;
 * null means "create, must not exist". A mismatch is a 409 with the current version.
 */
export async function writeNote(
  env: Env,
  p: Principal,
  space: SpaceRow,
  input: {
    path: string;
    content: string;
    baseVersion: string | null | undefined;
    message?: string | undefined;
  },
): Promise<{ path: string; version: string; commit_sha: string }> {
  const path = resolvePath(input.path, true);
  if (p.project) {
    const allowed = path === `projects/${p.project}.md` || path === `decisions/${p.project}.md`;
    if (!allowed && !path.startsWith('inbox/') && !path.startsWith('topics/')) {
      throw new HttpError(403, 'Forbidden', `This key is limited to the project "${p.project}".`);
    }
  }
  const content = redactSecrets(input.content).text;
  const version = await sha256Hex(content);

  const { sha } = await commitWithRetry(env, space, async (vault) => {
    await authorizeChanges(env, p, space.id, [{ path, content }]);
    const current = await vault.read(path);
    if (input.baseVersion !== undefined) {
      const currentVersion = current ? await sha256Hex(current.content) : null;
      if (currentVersion !== input.baseVersion) {
        throw conflict('The note changed since you read it.', {
          current_version: currentVersion,
          hint: 'Re-read the note with brain_read, merge your change, and write again with the new version.',
        });
      }
    }
    return {
      changes: [{ path, content }],
      meta: commitMeta(p, input.message ?? `${current ? 'Update' : 'Create'} ${path}`),
      result: null,
    };
  });

  await audit(env.DB, {
    spaceId: space.id,
    actorUserId: p.userId,
    actorKeyId: p.keyId,
    action: 'note.write',
    target: path,
    metadata: { commit: sha },
  });
  return { path, version, commit_sha: sha };
}

/**
 * Imports many files as one commit (e.g. an existing Obsidian vault). Paths are normalised but
 * not limited to the agent-writable folders; hidden files and non-Markdown files are skipped.
 * Content is redacted like every other write.
 */
export async function importFiles(
  env: Env,
  p: Principal,
  space: SpaceRow,
  files: { path: string; content: string }[],
  message?: string,
): Promise<ImportResponse> {
  authorize(p, 'vault.import', { spaceId: space.id });
  const skipped: ImportResponse['skipped'] = [];
  const accepted = new Map<string, string>();
  for (const f of files) {
    try {
      if (!/\.md$/i.test(f.path.trim())) throw new Error('not a Markdown file');
      accepted.set(normalizeVaultPath(f.path), redactSecrets(f.content).text);
    } catch (err) {
      skipped.push({ path: f.path, reason: err instanceof Error ? err.message : 'invalid' });
    }
  }
  if (accepted.size === 0) return { imported: 0, skipped, commit_sha: null };
  const { sha } = await commitWithRetry(env, space, async () => ({
    changes: [...accepted].map(([path, content]) => ({ path, content })),
    meta: commitMeta(p, message ?? `Import ${accepted.size} notes`),
    result: null,
  }));
  await audit(env.DB, {
    spaceId: space.id,
    actorUserId: p.userId,
    actorKeyId: p.keyId,
    action: 'vault.import',
    metadata: { commit: sha, files: accepted.size, skipped: skipped.length },
  });
  return { imported: accepted.size, skipped, commit_sha: sha };
}
