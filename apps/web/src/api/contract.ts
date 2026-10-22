/**
 * REST contract types for the web app. Everything comes from `@second-brain/schema`
 * (packages/schema/src/api.ts); the few local types below fill gaps in that contract and are
 * listed in the PR description so they can move into the schema package.
 *
 * Only `import type` is used, so no Zod code ends up in the web bundle.
 */
import type { NoteType } from '@second-brain/schema';

export type {
  ApiKey,
  CheckOutput,
  ConnectGitHubVaultResponse,
  ConnectInfo,
  CreateKeyResponse,
  DashboardResponse,
  DeviceRequestInfo,
  DisconnectGitHubVaultResponse,
  GitHubWebhookSetup,
  KeyScope,
  MagicLinkResponse,
  NoteDetail,
  NoteSummary,
  NoteType,
  OAuthGrant,
  OAuthGrantsResponse,
  Page,
  ProblemDetails,
  ProjectStatus,
  ProjectSummary,
  ProjectsResponse,
  SaveNoteRequest,
  SaveNoteResponse,
  SearchHit,
  SearchResponse,
  User,
  VaultStatus,
  VaultSyncDirection,
  VaultWebhookStatus,
} from '@second-brain/schema';

import type {
  KeyScope,
  VaultSyncDirection,
  MeResponse as SchemaMeResponse,
  SpaceSummary as SchemaSpaceSummary,
} from '@second-brain/schema';

/** Vault provider: `'managed'` (stored by Second Brain, ADR-0008) or `'github'`. */
export type VaultProvider = SchemaSpaceSummary['vault']['provider'];

export interface SpaceSummary extends Omit<SchemaSpaceSummary, 'vault'> {
  vault: { provider: VaultProvider; repo: string | null };
}

export interface MeResponse extends Omit<SchemaMeResponse, 'spaces'> {
  spaces: SpaceSummary[];
}

/**
 * Body of POST /api/v1/keys as the client sends it. The schema exports the Zod *output* type,
 * where defaulted fields (`scopes`) are required; the server applies the defaults.
 */
export interface CreateKeyInput {
  label: string;
  machine?: string;
  client?: string;
  scopes?: KeyScope[];
  project?: string;
  expires_in_days?: number;
}

/** Body of POST /api/v1/spaces/:id/vault/github as the client sends it (see `CreateKeyInput`). */
export interface ConnectGitHubVaultInput {
  repo: string;
  branch?: string;
  token: string;
  direction: VaultSyncDirection;
  confirm_overwrite?: boolean;
  create_webhook?: boolean;
}

/** Body of POST /api/v1/auth/device/approve as the client sends it (see `CreateKeyInput`). */
export interface DeviceApproveInput {
  user_code: string;
  approve: boolean;
  scopes?: KeyScope[];
  project?: string;
}

/** Query for GET /api/v1/notes (the schema's `ListNotesQuery` output type requires `limit`). */
export interface ListNotesParams {
  type?: NoteType;
  project?: string;
  cursor?: string;
  limit?: number;
}

/** Query for GET /api/v1/search. The contract documents it only as a URL comment. */
export interface SearchParams {
  q: string;
  types?: NoteType[];
  project?: string;
  limit?: number;
}
