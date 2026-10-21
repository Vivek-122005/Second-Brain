import { newId, sha256Hex } from '@second-brain/core';

export interface AuditEntry {
  spaceId: string | null;
  actorUserId: string | null;
  actorKeyId: string | null;
  action: string;
  target?: string | null;
  /** IDs and counts only, never note content or secrets (security.md §5). */
  metadata?: Record<string, unknown>;
}

/**
 * Appends to the hash-chained audit log (FR-SHR-06): each entry's hash covers the previous
 * entry's hash, so edits or deletions in the middle of the chain are detectable.
 */
export async function audit(db: D1Database, e: AuditEntry): Promise<void> {
  const prev = await db
    .prepare('SELECT hash FROM audit_log WHERE space_id IS ? ORDER BY at DESC, id DESC LIMIT 1')
    .bind(e.spaceId)
    .first<{ hash: string }>();
  const at = Date.now();
  const id = newId('aud', at);
  const metadata = JSON.stringify(e.metadata ?? {});
  const hash = await sha256Hex(
    [
      prev?.hash ?? '',
      id,
      e.spaceId ?? '',
      e.actorUserId ?? '',
      e.actorKeyId ?? '',
      e.action,
      e.target ?? '',
      metadata,
      at,
    ].join('|'),
  );
  await db
    .prepare(
      `INSERT INTO audit_log (id, space_id, actor_user_id, actor_key_id, action, target, metadata, at, prev_hash, hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      e.spaceId,
      e.actorUserId,
      e.actorKeyId,
      e.action,
      e.target ?? null,
      metadata,
      at,
      prev?.hash ?? null,
      hash,
    )
    .run();
}
