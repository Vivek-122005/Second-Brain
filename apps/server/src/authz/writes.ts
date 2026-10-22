import { buildNoteRecord } from '@second-brain/db';
import type { Principal } from '../auth/principal';
import type { Env } from '../env';
import type { FileChange } from '../vault';
import { authorize, can } from '.';

/**
 * Authorizes a change set before it is committed. A space-wide editor may change any file; with
 * only project-level grants every touched file must belong to a project the caller may write,
 * both before (the indexed note) and after (the new content) the change, so a file can be
 * neither moved into nor out of a project the caller does not hold.
 */
export async function authorizeChanges(
  env: Env,
  p: Principal,
  spaceId: string,
  changes: FileChange[],
): Promise<void> {
  if (can(p, 'note.write', { spaceId })) return;
  // Fails fast with the right message when the caller can't write here at all (scope, viewer).
  if (changes.length === 0) authorize(p, 'note.write', { spaceId });

  const existing = await env.DB.prepare(
    `SELECT path, project_slug FROM notes WHERE space_id = ?1 AND path IN (SELECT value FROM json_each(?2))`,
  )
    .bind(spaceId, JSON.stringify(changes.map((c) => c.path)))
    .all<{ path: string; project_slug: string | null }>();
  const before = new Map(existing.results.map((r) => [r.path, r.project_slug]));

  for (const change of changes) {
    const projects = new Set<string | null>();
    if (before.has(change.path)) projects.add(before.get(change.path) ?? null);
    if (change.content !== null) {
      const record = await buildNoteRecord(
        spaceId,
        { path: change.path, content: change.content },
        [],
      );
      projects.add(record.projectSlug);
    }
    for (const project of projects) authorize(p, 'note.write', { spaceId, project });
  }
}
