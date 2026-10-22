import { newId } from '@second-brain/core';
import type { GrantRole, SpaceRole, SpaceSummary } from '@second-brain/schema';

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

/** What the caller holds on a space: a space-wide role and/or project-level grants. */
export interface SpaceAccess {
  /** `owner` for your own spaces; the space-level grant's role; null if only project grants. */
  role: SpaceRole | null;
  /** Project-level grants (slug → role). */
  projects: Record<string, GrantRole>;
}

export interface ReadableSpace extends SpaceRow {
  owner_email: string;
  access: SpaceAccess;
}

const RANK: Record<SpaceRole, number> = { viewer: 1, editor: 2, admin: 3, owner: 4 };

/** The higher of two roles (`null` = no role). */
export function maxRole<R extends SpaceRole>(
  a: R | null | undefined,
  b: R | null | undefined,
): R | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return RANK[a] >= RANK[b] ? a : b;
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
    await attachPendingGrants(db, normalized);
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
  await attachPendingGrants(db, normalized);
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

/** Pending invitations sent to an email before it had an account now belong to that account. */
async function attachPendingGrants(db: D1Database, email: string): Promise<void> {
  await db
    .prepare(
      `UPDATE grants SET grantee_user_id = (SELECT id FROM users WHERE email = ?1 AND deleted_at IS NULL)
       WHERE grantee_email = ?1 AND grantee_user_id IS NULL AND status = 'pending'`,
    )
    .bind(email)
    .run();
}

type ReadableRow = SpaceRow & {
  owner_email: string;
  grant_role: GrantRole | null;
  grant_project: string | null;
  shared: number;
};

/**
 * Spaces a user may read, resolved on every request (no cache, so a revoke is effective on the
 * next request): their own, plus spaces and projects shared with them through accepted grants.
 * Agents (API keys, OAuth tokens) only see grants the recipient opted into their agent context
 * (`include_in_agent_context = 1`); the web session sees every accepted grant.
 *
 * Defaults to the agent view, so a caller that forgets the flag gets the narrower set.
 */
export async function readableSpaces(
  db: D1Database,
  userId: string,
  opts: { forAgent?: boolean } = {},
): Promise<ReadableSpace[]> {
  const forAgent = opts.forAgent ?? true;
  const r = await db
    .prepare(
      `SELECT s.*, u.email AS owner_email, NULL AS grant_role, NULL AS grant_project, 0 AS shared
       FROM spaces s JOIN users u ON u.id = s.owner_user_id
       WHERE s.owner_user_id = ?1
       UNION ALL
       SELECT s.*, u.email AS owner_email, g.role AS grant_role, g.project_slug AS grant_project, 1 AS shared
       FROM grants g JOIN spaces s ON s.id = g.space_id JOIN users u ON u.id = s.owner_user_id
       WHERE g.grantee_user_id = ?1 AND g.status = 'accepted' AND s.owner_user_id != ?1
         AND u.deleted_at IS NULL AND (?2 = 0 OR g.include_in_agent_context = 1)`,
    )
    .bind(userId, forAgent ? 1 : 0)
    .all<ReadableRow>();

  const byId = new Map<string, ReadableSpace & { shared: number }>();
  for (const row of r.results) {
    const { grant_role, grant_project, ...space } = row;
    let entry = byId.get(space.id);
    if (!entry) {
      entry = { ...space, access: { role: row.shared ? null : 'owner', projects: {} } };
      byId.set(space.id, entry);
    }
    if (!grant_role) continue;
    if (grant_project) {
      entry.access.projects[grant_project] =
        maxRole(entry.access.projects[grant_project], grant_role) ?? grant_role;
    } else {
      entry.access.role = maxRole(entry.access.role, grant_role);
    }
  }
  // Own spaces first (personal before team), then shared ones, oldest first.
  return [...byId.values()]
    .sort(
      (a, b) =>
        a.shared - b.shared ||
        Number(b.kind === 'personal') - Number(a.kind === 'personal') ||
        a.created_at - b.created_at,
    )
    .map(({ shared: _shared, ...s }) => s);
}

export function toSpaceSummary(s: ReadableSpace, userId: string): SpaceSummary {
  const own = s.owner_user_id === userId;
  const projects = Object.entries(s.access.projects).map(([slug, role]) => ({ slug, role }));
  const top = projects.reduce<SpaceRole | null>((m, x) => maxRole(m, x.role), s.access.role);
  return {
    id: s.id,
    name: s.name,
    kind: s.kind,
    role: own ? 'owner' : (top ?? 'viewer'),
    vault: { provider: s.vault_provider, repo: s.vault_repo },
    semantic_enabled: s.semantic_enabled === 1,
    ...(own ? {} : { source: { space: s.id, space_name: s.name, owner: s.owner_email } }),
    ...(!own && s.access.role === null ? { projects } : {}),
  };
}
