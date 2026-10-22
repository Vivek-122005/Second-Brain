import { z } from 'zod';

/**
 * Sharing contract (FR-SHR-02..04, 06; docs/04-collaboration/sharing-and-tenancy.md).
 *
 * A grant gives one user (by email) a role on a whole space or on one project inside it. It starts
 * `pending` and does nothing until the recipient accepts it; the recipient decides on accept
 * whether the shared content may enter their agents' context (`include_in_agent_context`).
 */

export const GrantRole = z.enum(['viewer', 'editor', 'admin']);
export type GrantRole = z.infer<typeof GrantRole>;

export const GrantStatus = z.enum(['pending', 'accepted', 'declined', 'revoked']);
export type GrantStatus = z.infer<typeof GrantStatus>;

/** Effective role on a space or project: the max of the space grant and the project grant. */
export type SpaceRole = 'owner' | GrantRole;

/** Where a result from someone else's space came from (security.md §4). Absent for your own. */
export interface SourceRef {
  /** Space id. Pass it back as `space_id` to read or write in that space. */
  space: string;
  space_name: string;
  /** Email of the space owner. */
  owner: string;
}

const projectSlug = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'project must be a lowercase slug, e.g. "billing-refactor"');

/** A grant as its space's owner or admins see it. */
export interface Grant {
  id: string;
  space_id: string;
  space_name: string;
  /** `null` = the whole space. */
  project: string | null;
  email: string;
  /** Set once the recipient has an account. */
  grantee_user_id: string | null;
  role: GrantRole;
  status: GrantStatus;
  include_in_agent_context: boolean;
  created_by: string;
  created_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
}

/** A grant as its recipient sees it (incoming invitations and accepted shares). */
export interface Invitation {
  id: string;
  space_id: string;
  space_name: string;
  project: string | null;
  role: GrantRole;
  status: GrantStatus;
  include_in_agent_context: boolean;
  owner: { email: string; name: string | null };
  invited_by: { email: string; name: string | null } | null;
  created_at: string;
  accepted_at: string | null;
}

/** POST /api/v1/grants → 201 `Grant` (web session, admin/owner of the space or project). */
export const CreateGrantRequest = z.object({
  space_id: z.string().min(1).max(64),
  project: projectSlug.optional(),
  email: z.email().max(254),
  role: GrantRole,
});
export type CreateGrantRequest = z.infer<typeof CreateGrantRequest>;

/** GET /api/v1/grants?space_id= → `Page<Grant>`: outgoing grants (revoked ones are left out). */
export const ListGrantsQuery = z.object({ space_id: z.string().min(1).max(64).optional() });
export type ListGrantsQuery = z.infer<typeof ListGrantsQuery>;

/** GET /api/v1/invitations?status=pending|accepted → `Page<Invitation>` (default `pending`). */
export const ListInvitationsQuery = z.object({
  status: z.enum(['pending', 'accepted']).default('pending'),
});
export type ListInvitationsQuery = z.infer<typeof ListInvitationsQuery>;

/** POST /api/v1/grants/:id/accept → 200 `Invitation` · POST /api/v1/grants/:id/decline → 200 `Invitation` */
export const AcceptGrantRequest = z.object({
  /** Off by default: shared content only reaches your agents if you say so. */
  include_in_agent_context: z.boolean().default(false),
});
export type AcceptGrantRequest = z.infer<typeof AcceptGrantRequest>;

/**
 * PATCH /api/v1/grants/:id → 200 `Grant`. `role` is for the space's owner/admins;
 * `include_in_agent_context` is for the recipient.
 */
export const UpdateGrantRequest = z
  .object({
    role: GrantRole.optional(),
    include_in_agent_context: z.boolean().optional(),
  })
  .refine((v) => v.role !== undefined || v.include_in_agent_context !== undefined, {
    message: 'Send role or include_in_agent_context.',
  });
export type UpdateGrantRequest = z.infer<typeof UpdateGrantRequest>;

/** DELETE /api/v1/grants/:id → 204 (revoke; effective on the next request). */
