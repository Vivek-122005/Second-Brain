import { z } from 'zod';
import { NoteType, ProjectStatus } from './notes';
import type { CheckOutput, ProjectSummary, SearchHit, SemanticStatus } from './tools';

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
  vault: { provider: 'managed' | 'github'; repo: string | null };
  /** Semantic (hybrid) search is on for this space (ADR-0004). */
  semantic_enabled?: boolean;
}
/** PATCH /api/v1/spaces/:id (space owner only) → `SpaceSummary`. Enabling semantic search starts a backfill. */
export const UpdateSpaceRequest = z.strictObject({ semantic_enabled: z.boolean() });
export type UpdateSpaceRequest = z.infer<typeof UpdateSpaceRequest>;
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

/** GET /api/v1/search?q=&types=topic,project&project=&limit=&mode=hybrid|keyword */
export interface SearchResponse {
  hits: SearchHit[];
  /** The mode that actually ran: `hybrid` only when semantic results were fused. */
  mode: 'keyword' | 'hybrid';
  /** Always sent by the server; optional so older clients and mocks still type-check. */
  semantic?: SemanticStatus;
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

// ── Import ─────────────────────────────────────────────────────────────────
/** POST /api/v1/import → imports Markdown files (e.g. an Obsidian vault) as one commit. */
export const ImportRequest = z.object({
  files: z
    .array(z.object({ path: z.string().min(1).max(300), content: z.string().max(500_000) }))
    .min(1)
    .max(500),
  message: z.string().max(200).optional(),
});
export type ImportRequest = z.infer<typeof ImportRequest>;
export interface ImportResponse {
  imported: number;
  skipped: { path: string; reason: string }[];
  commit_sha: string | null;
}

// ── Vault: GitHub sync ─────────────────────────────────────────────────────
/** `owner/name` of a GitHub repository. */
export const GitHubRepoName = z
  .string()
  .max(200)
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'repo must be "owner/name"');

/** A Git branch name (a conservative subset of git-check-ref-format). */
export const GitBranchName = z
  .string()
  .min(1)
  .max(200)
  .regex(
    /^(?![/.-])(?!.*(?:\.\.|\/\/|@\{|\.lock$|\/$|\.$))[A-Za-z0-9._/-]+$/,
    'invalid branch name',
  );

/**
 * Initial direction when connecting a space to a repository:
 * - `push_managed`: export the managed vault's files to the repo as one commit (the repo must
 *   have no notes yet, or `confirm_overwrite` must be true), then switch the space to GitHub.
 * - `adopt_repo`: import the repo's Markdown files and switch the space to GitHub (the managed
 *   vault must be empty, or `confirm_overwrite` must be true).
 */
export const VaultSyncDirection = z.enum(['push_managed', 'adopt_repo']);
export type VaultSyncDirection = z.infer<typeof VaultSyncDirection>;

/** POST /api/v1/spaces/:id/vault/github → 201 `ConnectGitHubVaultResponse` (space owner only) */
export const ConnectGitHubVaultRequest = z.object({
  repo: GitHubRepoName,
  /** Defaults to the repository's default branch. */
  branch: GitBranchName.optional(),
  /** Fine-grained personal access token with Contents read/write on this one repository. */
  token: z.string().min(10).max(500),
  direction: VaultSyncDirection,
  /** Required when the connect would overwrite existing notes on either side. */
  confirm_overwrite: z.boolean().default(false),
  /** Try to create the push webhook with the token (needs the Webhooks permission). */
  create_webhook: z.boolean().default(true),
});
export type ConnectGitHubVaultRequest = z.infer<typeof ConnectGitHubVaultRequest>;

export interface VaultWebhookStatus {
  /** True once we created the hook, or a correctly signed delivery (ping/push) arrived. */
  configured: boolean;
  /** True when Second Brain created the hook through the API. */
  auto_created: boolean;
  payload_url: string;
  last_delivery_at: string | null;
}

/** GET /api/v1/spaces/:id/vault (space owner only) */
export interface VaultStatus {
  space_id: string;
  provider: 'managed' | 'github';
  repo: string | null;
  branch: string | null;
  /** Vault commit the search index reflects. */
  last_synced_sha: string | null;
  last_synced_at: string | null;
  /** Why the last background sync failed, if it did. */
  last_sync_error: string | null;
  /** Null for managed spaces. */
  webhook: VaultWebhookStatus | null;
}

/** Shown once: what to enter in GitHub → Settings → Webhooks when it was not created for you. */
export interface GitHubWebhookSetup {
  payload_url: string;
  content_type: 'application/json';
  /** The webhook secret. Shown only in this response. */
  secret: string;
  events: ['push'];
  /** True when the hook was created automatically. */
  created: boolean;
  /** Why it was not created automatically, when it wasn't. */
  detail: string | null;
}

export interface ConnectGitHubVaultResponse {
  vault: VaultStatus;
  direction: VaultSyncDirection;
  /** Notes exported to the repository (push_managed). */
  exported: number;
  /** Notes indexed from the repository after the switch. */
  indexed: number;
  /** Commit created on the repository by push_managed, if any. */
  commit_sha: string | null;
  webhook: GitHubWebhookSetup;
}

/** DELETE /api/v1/spaces/:id/vault/github → 200 (space owner only): back to the managed vault. */
export interface DisconnectGitHubVaultResponse {
  vault: VaultStatus;
  /** Notes copied from the repository into the managed vault (new or changed). */
  imported: number;
  /** Managed notes removed because they no longer exist in the repository. */
  removed: number;
  /** Managed commit holding the imported files, or null when nothing changed. */
  commit_sha: string | null;
  /** Whether the webhook we created was removed from the repository. */
  webhook_removed: boolean;
}
