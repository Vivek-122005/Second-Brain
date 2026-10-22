import { newId } from '@second-brain/core';
import type {
  CreateGrantRequest,
  Grant,
  GrantRole,
  GrantStatus,
  Invitation,
  UpdateGrantRequest,
} from '@second-brain/schema';
import type { Principal } from '../auth/principal';
import { authorize, can } from '../authz';
import type { Env } from '../env';
import { badRequest, conflict, forbidden, notFound } from '../lib/http';
import { audit } from './audit';
import { sendInvite } from './mail';

/**
 * Consent-first sharing (sharing-and-tenancy.md §3). A grant is created `pending` and gives
 * nothing until its recipient accepts it; revoking flips it to `revoked`. The readable set is
 * resolved from this table on every request, so every change applies to the very next request.
 */

interface GrantRow {
  id: string;
  space_id: string;
  project_slug: string | null;
  grantee_user_id: string | null;
  grantee_email: string;
  role: GrantRole;
  status: GrantStatus;
  include_in_agent_context: number;
  created_by: string;
  created_at: number;
  accepted_at: number | null;
  revoked_at: number | null;
}

interface GrantJoinRow extends GrantRow {
  space_name: string;
  owner_user_id: string;
  owner_email: string;
  owner_name: string | null;
  inviter_email: string | null;
  inviter_name: string | null;
}

const SELECT_GRANT = `SELECT g.*, s.name AS space_name, s.owner_user_id, o.email AS owner_email,
    o.name AS owner_name, i.email AS inviter_email, i.name AS inviter_name
  FROM grants g
  JOIN spaces s ON s.id = g.space_id
  JOIN users o ON o.id = s.owner_user_id
  LEFT JOIN users i ON i.id = g.created_by`;

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

function toGrant(r: GrantJoinRow): Grant {
  return {
    id: r.id,
    space_id: r.space_id,
    space_name: r.space_name,
    project: r.project_slug,
    email: r.grantee_email,
    grantee_user_id: r.grantee_user_id,
    role: r.role,
    status: r.status,
    include_in_agent_context: r.include_in_agent_context === 1,
    created_by: r.created_by,
    created_at: new Date(r.created_at).toISOString(),
    accepted_at: iso(r.accepted_at),
    revoked_at: iso(r.revoked_at),
  };
}

function toInvitation(r: GrantJoinRow): Invitation {
  return {
    id: r.id,
    space_id: r.space_id,
    space_name: r.space_name,
    project: r.project_slug,
    role: r.role,
    status: r.status,
    include_in_agent_context: r.include_in_agent_context === 1,
    owner: { email: r.owner_email, name: r.owner_name },
    invited_by: r.inviter_email ? { email: r.inviter_email, name: r.inviter_name } : null,
    created_at: new Date(r.created_at).toISOString(),
    accepted_at: iso(r.accepted_at),
  };
}

async function loadGrant(env: Env, id: string): Promise<GrantJoinRow | null> {
  return env.DB.prepare(`${SELECT_GRANT} WHERE g.id = ?`).bind(id).first<GrantJoinRow>();
}

// A grant addressed by email belongs to an account only once that account has proven it owns the
// email (attachPendingGrants runs on verification). Matching on the bare email would let anyone
// who pre-registers someone else's address with a passkey receive what is shared with them.
const isRecipient = (p: Principal, g: GrantRow) => g.grantee_user_id === p.userId;

const mayManage = (p: Principal, g: GrantRow) =>
  can(p, 'grant.manage', { spaceId: g.space_id, project: g.project_slug });

function grantAudit(env: Env, p: Principal, g: GrantRow, action: string, extra = {}) {
  return audit(env.DB, {
    spaceId: g.space_id,
    actorUserId: p.userId,
    actorKeyId: p.keyId,
    action,
    target: g.id,
    // IDs only: no email addresses in the audit log (security.md §5).
    metadata: {
      role: g.role,
      project: g.project_slug,
      grantee: g.grantee_user_id ?? 'pending',
      ...extra,
    },
  });
}

export async function createGrant(
  env: Env,
  p: Principal,
  input: CreateGrantRequest,
  origin: string,
): Promise<Grant> {
  const project = input.project ?? null;
  authorize(p, 'grant.manage', { spaceId: input.space_id, project });
  const space = p.spaces.find((s) => s.id === input.space_id);
  if (!space) throw forbidden('You do not have access to that space.');
  const email = input.email.trim().toLowerCase();
  if (email === p.email.toLowerCase()) throw badRequest('You cannot share with yourself.');
  if (email === space.owner_email.toLowerCase())
    throw badRequest('That person owns this space already.');

  // Bind to an existing account only if it has proven the email; otherwise the grant waits,
  // addressed by email, until that proof (see attachPendingGrants).
  const grantee = await env.DB.prepare(
    'SELECT id FROM users WHERE email = ? AND deleted_at IS NULL AND email_verified_at IS NOT NULL',
  )
    .bind(email)
    .first<{ id: string }>();
  const id = newId('grt');
  try {
    await env.DB.prepare(
      `INSERT INTO grants (id, space_id, project_slug, grantee_user_id, grantee_email, role, status,
                           include_in_agent_context, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
    )
      .bind(id, space.id, project, grantee?.id ?? null, email, input.role, p.userId, Date.now())
      .run();
  } catch (err) {
    if (err instanceof Error && /UNIQUE/i.test(err.message))
      throw conflict('That person already has a pending or accepted grant here.');
    throw err;
  }
  const row = await loadGrant(env, id);
  if (!row) throw new Error('grant insert failed');
  await grantAudit(env, p, row, 'grant.create');
  try {
    await sendInvite(env, email, {
      from: p.name ?? p.email,
      spaceName: space.name,
      project,
      role: input.role,
      link: `${origin}/invitations`,
    });
  } catch (err) {
    // The grant stands either way: the recipient also sees it in their Invitations inbox.
    console.error(
      JSON.stringify({
        level: 'error',
        mail: 'invite',
        message: err instanceof Error ? err.message.slice(0, 200) : 'unknown',
      }),
    );
  }
  return toGrant(row);
}

/** Outgoing grants on spaces (or projects) the caller administers. Revoked ones are left out. */
export async function listGrants(env: Env, p: Principal, spaceId?: string): Promise<Grant[]> {
  const spaceIds = p.spaces.filter((s) => !spaceId || s.id === spaceId).map((s) => s.id);
  if (spaceId && spaceIds.length === 0) throw forbidden('You do not have access to that space.');
  const r = await env.DB.prepare(
    `${SELECT_GRANT} WHERE g.space_id IN (SELECT value FROM json_each(?)) AND g.status != 'revoked'
     ORDER BY g.created_at DESC`,
  )
    .bind(JSON.stringify(spaceIds))
    .all<GrantJoinRow>();
  return r.results.filter((g) => mayManage(p, g)).map(toGrant);
}

/** Grants addressed to the caller: pending invitations, or the shares they accepted. */
export async function listInvitations(
  env: Env,
  p: Principal,
  status: 'pending' | 'accepted',
): Promise<Invitation[]> {
  const r = await env.DB.prepare(
    `${SELECT_GRANT}
     WHERE g.grantee_user_id = ?1
       AND g.status = ?2 AND o.deleted_at IS NULL
     ORDER BY g.created_at DESC`,
  )
    .bind(p.userId, status)
    .all<GrantJoinRow>();
  return r.results.map(toInvitation);
}

/** Accept or decline (also "leave" an accepted share). Only the recipient, in a web session. */
export async function respondToGrant(
  env: Env,
  p: Principal,
  id: string,
  answer: 'accept' | 'decline',
  includeInAgentContext: boolean,
): Promise<Invitation> {
  if (p.via !== 'session') throw forbidden('Sign in to the web app to answer invitations.');
  const g = await loadGrant(env, id);
  if (!g || !isRecipient(p, g)) throw notFound('No invitation with that id.');
  const allowed = answer === 'accept' ? ['pending'] : ['pending', 'accepted'];
  if (!allowed.includes(g.status)) throw conflict(`This invitation is already ${g.status}.`);

  if (answer === 'accept') {
    await env.DB.prepare(
      `UPDATE grants SET status = 'accepted', grantee_user_id = ?2, accepted_at = ?3,
              include_in_agent_context = ?4
       WHERE id = ?1 AND status = 'pending'`,
    )
      .bind(id, p.userId, Date.now(), includeInAgentContext ? 1 : 0)
      .run();
  } else {
    await env.DB.prepare(
      `UPDATE grants SET status = 'declined', grantee_user_id = ?2 WHERE id = ?1`,
    )
      .bind(id, p.userId)
      .run();
  }
  const updated = (await loadGrant(env, id)) as GrantJoinRow;
  await grantAudit(env, p, updated, answer === 'accept' ? 'grant.accept' : 'grant.decline', {
    include_in_agent_context: updated.include_in_agent_context === 1,
  });
  return toInvitation(updated);
}

/**
 * Space admins/owners change the role; the recipient toggles include_in_agent_context. A change
 * either side may not make is a 403 (or 404 when the caller can't see the grant at all).
 */
export async function updateGrant(
  env: Env,
  p: Principal,
  id: string,
  patch: UpdateGrantRequest,
): Promise<Grant> {
  const g = await loadGrant(env, id);
  const manager = g ? mayManage(p, g) : false;
  const recipient = g ? isRecipient(p, g) : false;
  if (!g || (!manager && !recipient)) throw notFound('No grant with that id.');
  if (g.status !== 'pending' && g.status !== 'accepted')
    throw conflict(`This grant is ${g.status}.`);

  if (patch.role !== undefined) {
    if (!manager) authorize(p, 'grant.manage', { spaceId: g.space_id, project: g.project_slug });
    if (recipient) throw forbidden('You cannot change your own role.');
  }
  if (patch.include_in_agent_context !== undefined) {
    if (!recipient)
      throw forbidden('Only the recipient decides whether shared content enters their agents.');
    if (p.via !== 'session') throw forbidden('Sign in to the web app to change this.');
  }

  await env.DB.prepare(
    `UPDATE grants SET role = COALESCE(?2, role),
            include_in_agent_context = COALESCE(?3, include_in_agent_context)
     WHERE id = ?1`,
  )
    .bind(
      id,
      patch.role ?? null,
      patch.include_in_agent_context === undefined ? null : patch.include_in_agent_context ? 1 : 0,
    )
    .run();
  const updated = (await loadGrant(env, id)) as GrantJoinRow;
  await grantAudit(env, p, updated, 'grant.update', {
    ...(patch.role !== undefined ? { from_role: g.role } : {}),
    include_in_agent_context: updated.include_in_agent_context === 1,
  });
  return toGrant(updated);
}

/** Revokes a grant. Effective on the next request: nothing caches the readable set. */
export async function revokeGrant(env: Env, p: Principal, id: string): Promise<void> {
  const g = await loadGrant(env, id);
  if (!g || !p.spaces.some((s) => s.id === g.space_id)) throw notFound('No grant with that id.');
  authorize(p, 'grant.manage', { spaceId: g.space_id, project: g.project_slug });
  if (g.status === 'revoked') return;
  await env.DB.prepare(`UPDATE grants SET status = 'revoked', revoked_at = ? WHERE id = ?`)
    .bind(Date.now(), id)
    .run();
  await grantAudit(env, p, { ...g, status: 'revoked' }, 'grant.revoke');
}
