import { newId, sha256Hex } from '@second-brain/core';
import {
  type CommitMeta,
  type FileChange,
  VaultConflictError,
  type VaultFileVersion,
  type VaultStore,
} from './types';

/**
 * Managed vault: files live in D1 (`vault_files`), every write is a commit row (`vault_commits`)
 * with the list of changes, and `vault_heads` holds the head pointer. A commit is one D1 batch:
 * a compare-and-swap on the head, then file writes guarded on the new head, so a lost race
 * changes nothing (ADR-0008).
 */
export class ManagedVaultStore implements VaultStore {
  readonly provider = 'managed' as const;

  constructor(
    private readonly db: D1Database,
    private readonly spaceId: string,
  ) {}

  async head(): Promise<string | null> {
    const row = await this.db
      .prepare('SELECT head FROM vault_heads WHERE space_id = ?')
      .bind(this.spaceId)
      .first<{ head: string | null }>();
    return row?.head ?? null;
  }

  async read(path: string): Promise<VaultFileVersion | null> {
    const row = await this.db
      .prepare(
        'SELECT path, content, blob_sha AS sha FROM vault_files WHERE space_id = ? AND path = ?',
      )
      .bind(this.spaceId, path)
      .first<VaultFileVersion>();
    return row ?? null;
  }

  async readAll(): Promise<VaultFileVersion[]> {
    const r = await this.db
      .prepare(
        'SELECT path, content, blob_sha AS sha FROM vault_files WHERE space_id = ? ORDER BY path',
      )
      .bind(this.spaceId)
      .all<VaultFileVersion>();
    return r.results;
  }

  async commit(
    changes: FileChange[],
    meta: CommitMeta,
    expectedHead: string | null,
  ): Promise<string> {
    if (changes.length === 0) throw new Error('Nothing to commit');
    const id = newId('chk').replace(/^chk_/, 'c_');
    const now = Date.now();
    const withSha = await Promise.all(
      changes.map(async (ch) => ({
        path: ch.path,
        content: ch.content,
        sha: ch.content === null ? null : await sha256Hex(ch.content),
      })),
    );
    const puts = JSON.stringify(withSha.filter((c) => c.content !== null));
    const dels = JSON.stringify(withSha.filter((c) => c.content === null).map((c) => c.path));
    const summary = JSON.stringify(
      withSha.map((c) => ({
        path: c.path,
        op: c.content === null ? 'delete' : 'put',
        blob_sha: c.sha,
      })),
    );
    const author = `${meta.author.name} <${meta.author.email}>`;
    const guard = `(SELECT head FROM vault_heads WHERE space_id = ?1) = ?2`;

    const results = await this.db.batch([
      // 1. Compare-and-swap the head. Inserting covers the very first commit of a space.
      expectedHead === null
        ? this.db
            .prepare(
              'INSERT INTO vault_heads (space_id, head) VALUES (?1, ?2) ON CONFLICT (space_id) DO UPDATE SET head = ?2 WHERE vault_heads.head IS NULL',
            )
            .bind(this.spaceId, id)
        : this.db
            .prepare('UPDATE vault_heads SET head = ?2 WHERE space_id = ?1 AND head = ?3')
            .bind(this.spaceId, id, expectedHead),
      // 2. Everything else only applies if this commit now owns the head.
      this.db
        .prepare(
          `INSERT INTO vault_commits (id, space_id, parent_id, message, author, changes, created_at)
           SELECT ?2, ?1, ?3, ?4, ?5, ?6, ?7 WHERE ${guard}`,
        )
        .bind(this.spaceId, id, expectedHead, meta.message, author, summary, now),
      this.db
        .prepare(
          `INSERT INTO vault_files (space_id, path, content, blob_sha, commit_id, updated_at)
           SELECT ?1, json_extract(value, '$.path'), json_extract(value, '$.content'), json_extract(value, '$.sha'), ?2, ?4
           FROM json_each(?3) WHERE ${guard}
           ON CONFLICT (space_id, path) DO UPDATE SET content = excluded.content, blob_sha = excluded.blob_sha,
             commit_id = excluded.commit_id, updated_at = excluded.updated_at`,
        )
        .bind(this.spaceId, id, puts, now),
      this.db
        .prepare(
          `DELETE FROM vault_files WHERE space_id = ?1 AND path IN (SELECT value FROM json_each(?3)) AND ${guard}`,
        )
        .bind(this.spaceId, id, dels),
    ]);

    if ((results[0]?.meta.changes ?? 0) !== 1) throw new VaultConflictError();
    return id;
  }
}
