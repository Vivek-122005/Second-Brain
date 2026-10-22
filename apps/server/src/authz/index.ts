import type { KeyScope, SourceRef, SpaceRole } from '@second-brain/schema';
import type { Principal } from '../auth/principal';
import { forbidden } from '../lib/http';
import { maxRole } from '../services/spaces';

/**
 * The one place that decides who may do what (security.md §3, sharing-and-tenancy.md §2).
 *
 * Permission = effective role on the resource ∩ key/OAuth scope. Handlers call `can`/`authorize`
 * and `readScope`; they never compare owner ids or roles themselves.
 */

export type Action =
  | 'note.read'
  | 'note.write'
  | 'decision.supersede'
  | 'vault.import'
  | 'grant.manage'
  | 'audit.read'
  | 'vault.connect'
  | 'semantic.enable'
  | 'space.delete'
  | 'space.transfer';

export interface Resource {
  spaceId: string;
  /** The project the resource belongs to; project-level grants only count when this is set. */
  project?: string | null;
}

interface Rule {
  /** Roles allowed, mirroring the columns of the spec's permission matrix. */
  roles: readonly SpaceRole[];
  /** Key/OAuth scope the caller must also hold. */
  scope: KeyScope;
  /** Whether agents (API keys, OAuth tokens) may do it, or only a signed-in person. */
  agents: boolean;
  /** Needs a space-wide role: project-level grants don't count. */
  spaceWide?: boolean;
}

const READERS = ['viewer', 'editor', 'admin', 'owner'] as const;
const WRITERS = ['editor', 'admin', 'owner'] as const;
const ADMINS = ['admin', 'owner'] as const;
const OWNER = ['owner'] as const;

/**
 * The permission matrix (sharing-and-tenancy.md §2). Sharing is people-only: a prompt-injected
 * agent must not be able to share your memory with someone else or accept content into your
 * context, so grant changes need a web session whatever the key's scopes.
 */
export const PERMISSIONS: Readonly<Record<Action, Rule>> = {
  'note.read': { roles: READERS, scope: 'read', agents: true },
  'note.write': { roles: WRITERS, scope: 'write', agents: true },
  'decision.supersede': { roles: WRITERS, scope: 'write', agents: true },
  'vault.import': { roles: WRITERS, scope: 'write', agents: true, spaceWide: true },
  'grant.manage': { roles: ADMINS, scope: 'write', agents: false },
  'audit.read': { roles: ADMINS, scope: 'read', agents: true },
  'vault.connect': { roles: OWNER, scope: 'write', agents: false, spaceWide: true },
  'semantic.enable': { roles: OWNER, scope: 'write', agents: false, spaceWide: true },
  'space.delete': { roles: OWNER, scope: 'write', agents: false, spaceWide: true },
  'space.transfer': { roles: OWNER, scope: 'write', agents: false, spaceWide: true },
};

export const isAgent = (p: Principal): boolean => p.via !== 'session';

/**
 * The caller's role on a space, or on one project in it: max(space grant, project grant).
 * `null` when the space is not readable by this caller (no grant, pending, revoked, or hidden
 * from agents).
 */
export function effectiveRole(
  p: Principal,
  spaceId: string,
  projectSlug?: string | null,
): SpaceRole | null {
  const s = p.spaces.find((x) => x.id === spaceId);
  if (!s) return null;
  if (s.owner_user_id === p.userId) return 'owner';
  return maxRole(s.access.role, projectSlug ? s.access.projects[projectSlug] : null);
}

export function can(p: Principal, action: Action, resource: Resource): boolean {
  const rule = PERMISSIONS[action];
  if (!rule.agents && isAgent(p)) return false;
  if (!p.scopes.includes(rule.scope)) return false;
  if (p.project && resource.project && resource.project !== p.project) return false;
  const role = effectiveRole(p, resource.spaceId, rule.spaceWide ? null : resource.project);
  return role !== null && rule.roles.includes(role);
}

/** `can`, or a 403 that says why in terms the caller can act on. */
export function authorize(p: Principal, action: Action, resource: Resource): void {
  if (can(p, action, resource)) return;
  const rule = PERMISSIONS[action];
  if (!rule.agents && isAgent(p)) throw forbidden('Sign in to the web app to do this.');
  if (!p.scopes.includes(rule.scope))
    throw forbidden(`This key does not have the "${rule.scope}" scope.`);
  if (p.project && resource.project && resource.project !== p.project)
    throw forbidden(`This key is limited to the project "${p.project}".`);
  const role = effectiveRole(p, resource.spaceId, rule.spaceWide ? null : resource.project);
  if (role === null && !p.spaces.some((s) => s.id === resource.spaceId))
    throw forbidden('You do not have access to that space.');
  const where = resource.project ? `the project "${resource.project}"` : 'this space';
  throw forbidden(
    role
      ? `Your role on ${where} (${role}) does not allow this.`
      : `You do not have access to ${where}.`,
  );
}

/**
 * The read scope handed to `@second-brain/db` queries: a space id for a space-wide role, or
 * `space_id:project` for each project-level grant, so other projects are filtered in SQL.
 */
export function readScope(p: Principal, opts: { spaceId?: string; ownOnly?: boolean } = {}) {
  const out: string[] = [];
  for (const s of p.spaces) {
    if (opts.spaceId && s.id !== opts.spaceId) continue;
    const own = s.owner_user_id === p.userId;
    if (opts.ownOnly && !own) continue;
    if (own || s.access.role) out.push(s.id);
    else for (const slug of Object.keys(s.access.projects)) out.push(`${s.id}:${slug}`);
  }
  return out;
}

/** Provenance for results from a space shared with the caller; `undefined` for their own. */
export function sourceOf(p: Principal, spaceId: string): SourceRef | undefined {
  const s = p.spaces.find((x) => x.id === spaceId);
  if (!s || s.owner_user_id === p.userId) return undefined;
  return { space: s.id, space_name: s.name, owner: s.owner_email };
}

/** Spreads `{ source }` into a result when it came from a shared space. */
export function withSource<T extends object>(p: Principal, spaceId: string, item: T): T {
  const source = sourceOf(p, spaceId);
  return source ? { ...item, source } : item;
}
