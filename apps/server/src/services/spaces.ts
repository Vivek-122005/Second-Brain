import { newId } from '@second-brain/core';
import type { SpaceSummary } from '@second-brain/schema';

export interface UserRow {
  id: string;
  email: string;
  name: string | null;
  created_at: number;
  deleted_at: number | null;
}

export interface SpaceRow {
  id: string;
  owner_user_id: string;
  name: string;
  kind: 'personal' | 'team';
  vault_provider: 'managed' | 'github';
  vault_repo: string | null;
  vault_branch: string | null;
  vault_token_enc: string | null;
  webhook_secret_enc: string | null;
  semantic_enabled: number;
  created_at: number;
}

export async function getUser(db: D1Database, id: string): Promise<UserRow | null> {
  return db
    .prepare('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL')
    .bind(id)
    .first<UserRow>();
}

/** Finds or creates the user for a verified email, with their personal space (FR-SHR-01). */
export async function upsertUserByEmail(db: D1Database, email: string): Promise<UserRow> {
  const normalized = email.trim().toLowerCase();
  const existing = await db
    .prepare('SELECT * FROM users WHERE email = ? AND deleted_at IS NULL')
    .bind(normalized)
    .first<UserRow>();
  if (existing) {
    await ensurePersonalSpace(db, existing);
    return existing;
  }
  const user: UserRow = {
    id: newId('usr'),
    email: normalized,
    name: null,
    created_at: Date.now(),
    deleted_at: null,
  };
  await db
    .prepare(
      'INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (email) DO NOTHING',
    )
    .bind(user.id, user.email, user.name, user.created_at)
    .run();
  const saved = await db
    .prepare('SELECT * FROM users WHERE email = ?')
    .bind(normalized)
    .first<UserRow>();
  if (!saved) throw new Error('user upsert failed');
  await ensurePersonalSpace(db, saved);
  return saved;
}

export async function ensurePersonalSpace(db: D1Database, user: UserRow): Promise<SpaceRow> {
  const found = await db
    .prepare(
      "SELECT * FROM spaces WHERE owner_user_id = ? AND kind = 'personal' ORDER BY created_at LIMIT 1",
    )
    .bind(user.id)
    .first<SpaceRow>();
  if (found) return found;
  const id = newId('spc');
  await db
    .prepare(
      `INSERT INTO spaces (id, owner_user_id, name, kind, vault_provider, created_at)
       VALUES (?, ?, 'Personal', 'personal', 'managed', ?)`,
    )
    .bind(id, user.id, Date.now())
    .run();
  const space = await db.prepare('SELECT * FROM spaces WHERE id = ?').bind(id).first<SpaceRow>();
  if (!space) throw new Error('space creation failed');
  return space;
}

/** Spaces a user may read: their own (shared spaces arrive with grants in Phase 4). */
export async function readableSpaces(db: D1Database, userId: string): Promise<SpaceRow[]> {
  const r = await db
    .prepare(
      "SELECT * FROM spaces WHERE owner_user_id = ? ORDER BY kind = 'personal' DESC, created_at",
    )
    .bind(userId)
    .all<SpaceRow>();
  return r.results;
}

export function toSpaceSummary(s: SpaceRow, userId: string): SpaceSummary {
  return {
    id: s.id,
    name: s.name,
    kind: s.kind,
    role: s.owner_user_id === userId ? 'owner' : 'viewer',
    vault: { provider: s.vault_provider, repo: s.vault_repo },
    semantic_enabled: s.semantic_enabled === 1,
  };
}
