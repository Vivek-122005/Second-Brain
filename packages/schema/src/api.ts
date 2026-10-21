import { z } from 'zod';
import { NoteType, ProjectStatus } from './notes';
import type { CheckOutput, ProjectSummary, SearchHit } from './tools';

/**
 * REST API contract (`/api/v1`, LLD §6). Request bodies are Zod schemas (validated by the server);
 * responses are plain interfaces shared by the web app and the CLI.
 *
 * Conventions: JSON everywhere; errors are RFC 9457 `application/problem+json` (`ProblemDetails`);
 * list endpoints return `{ items, next_cursor }`; the web app authenticates with an HttpOnly session
 * cookie, the CLI and MCP clients with `Authorization: Bearer sb_live_…`.
 */

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  /** Field-level validation errors. */
  errors?: { path: string; message: string }[];
}

export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

// ── Auth ───────────────────────────────────────────────────────────────────
/** POST /api/v1/auth/magic-link → 202 `MagicLinkResponse` */
export const MagicLinkRequest = z.object({ email: z.email().max(254) });
export type MagicLinkRequest = z.infer<typeof MagicLinkRequest>;
export interface MagicLinkResponse {
  sent: true;
  /** Only in local development (no email provider): the link to open. */
  dev_link?: string;
}
/** GET /api/v1/auth/verify?token=… → sets the session cookie and redirects to `/`. */
/** POST /api/v1/auth/logout → 204 */

export interface User {
  id: string;
  email: string;
  name: string | null;
}
export interface SpaceSummary {
  id: string;
  name: string;
  kind: 'personal' | 'team';
  role: 'owner' | 'admin' | 'editor' | 'viewer';
  vault: { provider: 'memory' | 'github'; repo: string | null };
}
/** GET /api/v1/me */
export interface MeResponse {
  user: User;
  spaces: SpaceSummary[];
  default_space_id: string;
}

// ── Device login for the CLI (RFC 8628-style) ─────────────────────────────
/** POST /api/v1/auth/device (no auth) */
export const DeviceStartRequest = z.object({
  client: z.string().min(1).max(40),
  machine: z.string().min(1).max(80),
});
export type DeviceStartRequest = z.infer<typeof DeviceStartRequest>;
export interface DeviceStartResponse {
  device_code: string;
  /** Short code the user confirms in the browser, e.g. `WDJB-MJHT`. */
  user_code: string;
  /** Web page where the user approves: `<origin>/device`. */
  verification_uri: string;
  verification_uri_complete: string;
  interval: number;
  expires_in: number;
}
/** POST /api/v1/auth/device/token (no auth) → 200 `DeviceTokenResponse`, or 428 `{error:"authorization_pending"}`, 403 `access_denied`, 410 `expired_token` */
export const DeviceTokenRequest = z.object({ device_code: z.string().min(1) });
export type DeviceTokenRequest = z.infer<typeof DeviceTokenRequest>;
export interface DeviceTokenResponse {
  key: ApiKey;
  /** The API key secret. Shown once. */
  secret: string;
  api_url: string;
  mcp_url: string;
}
/** GET /api/v1/auth/device/:user_code (session auth) → pending request details for the approval page. */
export interface DeviceRequestInfo {
  user_code: string;
  client: string;
  machine: string;
  created_at: string;
  expires_at: string;
}
/** POST /api/v1/auth/device/approve (session auth) */
export const DeviceApproveRequest = z.object({
  user_code: z.string().min(1),
  approve: z.boolean(),
  scopes: z
    .array(z.enum(['read', 'write']))
    .min(1)
    .default(['read', 'write']),
  project: z.string().optional(),
});
export type DeviceApproveRequest = z.infer<typeof DeviceApproveRequest>;

// ── API keys ───────────────────────────────────────────────────────────────
export const KeyScope = z.enum(['read', 'write']);
export type KeyScope = z.infer<typeof KeyScope>;

export interface ApiKey {
  id: string;
  label: string;
  machine: string | null;
  client: string | null;
  /** Visible prefix, e.g. `sb_live_ab12`. */
  prefix: string;
  scopes: KeyScope[];
  space_id: string | null;
  project: string | null;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
}
/** GET /api/v1/keys → `Page<ApiKey>` · DELETE /api/v1/keys/:id → 204 */
/** POST /api/v1/keys → 201 `CreateKeyResponse` */
export const CreateKeyRequest = z.object({
  label: z.string().min(1).max(80),
  machine: z.string().max(80).optional(),
  client: z.string().max(40).optional(),
  scopes: z.array(KeyScope).min(1).default(['read', 'write']),
  project: z.string().optional(),
  expires_in_days: z.number().int().min(1).max(3650).optional(),
});
export type CreateKeyRequest = z.infer<typeof CreateKeyRequest>;
export interface CreateKeyResponse {
  key: ApiKey;
  secret: string;
}

// ── Notes ──────────────────────────────────────────────────────────────────
export interface NoteSummary {
  path: string;
  title: string;
  type: NoteType;
  project: string | null;
  tags: string[];
  updated_at: string;
}
/** GET /api/v1/notes?type=&project=&cursor=&limit= → `Page<NoteSummary>` */
export const ListNotesQuery = z.object({
  type: NoteType.optional(),
  project: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListNotesQuery = z.infer<typeof ListNotesQuery>;

/** GET /api/v1/note?path=… */
export interface NoteDetail extends NoteSummary {
  frontmatter: Record<string, unknown>;
  /** Body without frontmatter. */
  body: string;
  /** Full file as stored, frontmatter included. Send this back (edited) in `SaveNoteRequest.content`. */
  raw: string;
  /** Opaque version for optimistic concurrency. */
  version: string;
  links: { target: string; path: string | null }[];
  backlinks: { path: string; title: string }[];
}
/** PUT /api/v1/note → 200 `SaveNoteResponse`, 409 when `base_version` is stale */
export const SaveNoteRequest = z.object({
  path: z.string().min(1).max(300),
  content: z.string().max(200_000),
  base_version: z.string().nullable(),
  message: z.string().max(200).optional(),
});
export type SaveNoteRequest = z.infer<typeof SaveNoteRequest>;
export interface SaveNoteResponse {
  path: string;
  version: string;
  commit_sha: string;
}

/** GET /api/v1/search?q=&types=topic,project&project=&limit= */
export interface SearchResponse {
  hits: SearchHit[];
  mode: 'keyword' | 'hybrid';
}

/** GET /api/v1/projects?status= */
export const ListProjectsQuery = z.object({ status: ProjectStatus.optional() });
export interface ProjectsResponse {
  items: ProjectSummary[];
}

/** GET /api/v1/dashboard */
export interface DashboardResponse {
  projects: ProjectSummary[];
  recent_sessions: {
    id: string;
    date: string;
    summary: string;
    project: string | null;
    path: string;
  }[];
  recent_decisions: {
    id: string;
    title: string;
    date: string;
    project: string | null;
    path: string;
  }[];
  check: CheckOutput;
  stats: { notes: number; topics: number; decisions: number; sessions: number };
}

/** GET /api/v1/graph */
export interface GraphResponse {
  nodes: { id: string; title: string; type: NoteType }[];
  edges: { source: string; target: string }[];
}

/** GET /api/v1/connect → snippets the web app shows for one-click client setup (FR-WEB-04). */
export interface ConnectInfo {
  mcp_url: string;
  api_url: string;
}
