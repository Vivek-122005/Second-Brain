import type {
  ApiKey,
  ConnectGitHubVaultInput,
  ConnectGitHubVaultResponse,
  ConnectInfo,
  CreateKeyInput,
  CreateKeyResponse,
  DashboardResponse,
  DeviceApproveInput,
  DeviceRequestInfo,
  DisconnectGitHubVaultResponse,
  ListNotesParams,
  MagicLinkResponse,
  MeResponse,
  NoteDetail,
  NoteSummary,
  OAuthGrantsResponse,
  Page,
  ProblemDetails,
  ProjectStatus,
  ProjectsResponse,
  SaveNoteRequest,
  SaveNoteResponse,
  SearchParams,
  SearchResponse,
  VaultStatus,
} from './contract';
import {
  GOOGLE_START_PATH,
  type AuthProviders,
  type MagicLinkInput,
  type Passkey,
  type RenamePasskeyInput,
  type PasskeyLoginOptionsInput,
  type PasskeyLoginOptionsResponse,
  type PasskeyLoginVerifyInput,
  type PasskeyLoginVerifyResponse,
  type PasskeyRegisterOptionsInput,
  type PasskeyRegisterOptionsResponse,
  type PasskeyRegisterVerifyInput,
  type PasskeyRegisterVerifyResponse,
} from './auth-contract';

/**
 * A failed API call, parsed from an RFC 9457 `application/problem+json` body when there is one.
 * `status` 0 means the request never got a response (offline, DNS, CORS).
 */
export class ApiError extends Error {
  readonly status: number;
  readonly title: string;
  readonly detail: string | undefined;
  readonly type: string;
  readonly errors: { path: string; message: string }[];
  /** RFC 9457 extension members, e.g. `repo_notes` on a vault connect conflict. */
  readonly extensions: Record<string, unknown>;

  constructor(problem: ProblemDetails, extensions: Record<string, unknown> = {}) {
    super(problem.detail ? `${problem.title}: ${problem.detail}` : problem.title);
    this.name = 'ApiError';
    this.status = problem.status;
    this.title = problem.title;
    this.detail = problem.detail;
    this.type = problem.type;
    this.errors = problem.errors ?? [];
    this.extensions = extensions;
  }

  get isUnauthorized(): boolean {
    return this.status === 401;
  }
  get isConflict(): boolean {
    return this.status === 409;
  }
  get isNotFound(): boolean {
    return this.status === 404;
  }
}

export function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError;
}

const PROBLEM_MEMBERS = new Set([
  'type',
  'title',
  'status',
  'detail',
  'instance',
  'errors',
  'error',
  'message',
]);

const STATUS_TITLES: Record<number, string> = {
  400: 'Bad request',
  401: 'Not signed in',
  403: 'Not allowed',
  404: 'Not found',
  409: 'Conflict',
  410: 'Gone',
  422: 'Invalid input',
  428: 'Pending',
  429: 'Too many requests',
  500: 'Server error',
  502: 'Bad gateway',
  503: 'Service unavailable',
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Turns any non-2xx response into an `ApiError`. Accepts proper problem+json, plain JSON with an
 * `error`/`message` field (e.g. the device-token endpoint's `{ error: "access_denied" }`), or no
 * body at all. Never includes the response body text verbatim beyond the known fields.
 */
export async function parseErrorResponse(res: Response): Promise<ApiError> {
  const fallbackTitle = STATUS_TITLES[res.status] ?? (res.statusText || 'Request failed');
  let body: unknown = null;
  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('json')) {
    try {
      body = await res.json();
    } catch {
      body = null;
    }
  }
  if (!isRecord(body)) {
    return new ApiError({ type: 'about:blank', title: fallbackTitle, status: res.status });
  }
  const title =
    typeof body.title === 'string' && body.title
      ? body.title
      : typeof body.error === 'string'
        ? body.error
        : fallbackTitle;
  const detail =
    typeof body.detail === 'string'
      ? body.detail
      : typeof body.message === 'string'
        ? body.message
        : undefined;
  const errors = Array.isArray(body.errors)
    ? body.errors.filter(
        (e): e is { path: string; message: string } =>
          isRecord(e) && typeof e.path === 'string' && typeof e.message === 'string',
      )
    : undefined;
  const extensions = Object.fromEntries(
    Object.entries(body).filter(([k]) => !PROBLEM_MEMBERS.has(k)),
  );
  return new ApiError(
    {
      type: typeof body.type === 'string' ? body.type : 'about:blank',
      title,
      status: typeof body.status === 'number' ? body.status : res.status,
      ...(detail !== undefined ? { detail } : {}),
      ...(errors ? { errors } : {}),
    },
    extensions,
  );
}

/** Everything the UI can ask of the server. The HTTP client and the mock both satisfy it. */
export interface ApiClient {
  readonly mode: 'http' | 'mock';
  /** Which sign-in methods the server offers. */
  authProviders(): Promise<AuthProviders>;
  passkeyRegisterOptions(req: PasskeyRegisterOptionsInput): Promise<PasskeyRegisterOptionsResponse>;
  passkeyRegisterVerify(req: PasskeyRegisterVerifyInput): Promise<PasskeyRegisterVerifyResponse>;
  passkeyLoginOptions(req: PasskeyLoginOptionsInput): Promise<PasskeyLoginOptionsResponse>;
  passkeyLoginVerify(req: PasskeyLoginVerifyInput): Promise<PasskeyLoginVerifyResponse>;
  listPasskeys(): Promise<Passkey[]>;
  renamePasskey(id: string, req: RenamePasskeyInput): Promise<Passkey>;
  /** Fails with 409 when the passkey is the account's last sign-in method. */
  deletePasskey(id: string): Promise<void>;
  /** Starts Google sign-in (a full-page redirect against a real server). */
  startGoogleSignIn(redirect: string): Promise<void>;
  requestMagicLink(req: MagicLinkInput): Promise<MagicLinkResponse>;
  /** Opens a `dev_link` from the magic-link response (a full navigation against a real server). */
  followDevLink(link: string): Promise<void>;
  logout(): Promise<void>;
  me(): Promise<MeResponse>;
  /** MCP clients approved on the OAuth consent screen ("Connected apps"). */
  listOAuthGrants(): Promise<OAuthGrantsResponse>;
  /** Disconnects the app: revokes every access and refresh token it holds. */
  revokeOAuthGrant(id: string): Promise<void>;
  vaultStatus(spaceId: string): Promise<VaultStatus>;
  /** Fails with 409 (`repo_notes` / `managed_notes`) until `confirm_overwrite` is set. */
  connectGitHubVault(
    spaceId: string,
    req: ConnectGitHubVaultInput,
  ): Promise<ConnectGitHubVaultResponse>;
  /** `skipImport` switches back without copying the repository (when it can't be read). */
  disconnectGitHubVault(
    spaceId: string,
    opts?: { skipImport?: boolean },
  ): Promise<DisconnectGitHubVaultResponse>;
  dashboard(): Promise<DashboardResponse>;
  listNotes(params?: ListNotesParams): Promise<Page<NoteSummary>>;
  getNote(path: string): Promise<NoteDetail>;
  saveNote(req: SaveNoteRequest): Promise<SaveNoteResponse>;
  search(params: SearchParams): Promise<SearchResponse>;
  projects(status?: ProjectStatus): Promise<ProjectsResponse>;
  listKeys(): Promise<Page<ApiKey>>;
  createKey(req: CreateKeyInput): Promise<CreateKeyResponse>;
  revokeKey(id: string): Promise<void>;
  connect(): Promise<ConnectInfo>;
  deviceRequest(userCode: string): Promise<DeviceRequestInfo>;
  approveDevice(req: DeviceApproveInput): Promise<void>;
  /** Mock-only developer helpers (undefined against a real server). */
  readonly dev?: DevTools;
}

export interface DevTools {
  /** Changes a note "from another device" so the next save with the old version gets a 409. */
  simulateRemoteEdit(path: string): Promise<void>;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpClientOptions {
  /** Origin of the API, e.g. `https://brain.example.com`. Empty string = same origin. */
  baseUrl?: string;
  fetch?: FetchLike;
  /** How to open a dev sign-in link. Defaults to a full page navigation. */
  openLink?: (url: string) => Promise<void>;
  mode?: 'http' | 'mock';
  dev?: DevTools;
}

type Query = Record<string, string | number | undefined | null>;

function toQueryString(query: Query | undefined): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

export function createHttpClient(opts: HttpClientOptions = {}): ApiClient {
  const baseUrl = (opts.baseUrl ?? '').replace(/\/+$/, '');
  const doFetch: FetchLike = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const openLink =
    opts.openLink ??
    (async (url: string) => {
      window.location.assign(url);
    });

  async function request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    options: { query?: Query; body?: unknown } = {},
  ): Promise<T> {
    const url = `${baseUrl}/api/v1${path}${toQueryString(options.query)}`;
    const headers: Record<string, string> = { Accept: 'application/json' };
    const init: RequestInit = { method, credentials: 'include', headers };
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }
    let res: Response;
    try {
      res = await doFetch(url, init);
    } catch {
      throw new ApiError({
        type: 'about:blank',
        title: 'Network error',
        status: 0,
        detail: 'Could not reach the server. Check your connection and try again.',
      });
    }
    if (!res.ok) throw await parseErrorResponse(res);
    // 204 (logout, revoke) has no body; 202 (magic link) does. Read text so both work.
    const text = res.status === 204 ? '' : await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  const client: ApiClient = {
    mode: opts.mode ?? 'http',
    authProviders: () => request<AuthProviders>('GET', '/auth/providers'),
    passkeyRegisterOptions: (req) =>
      request<PasskeyRegisterOptionsResponse>('POST', '/auth/passkey/register/options', {
        body: req,
      }),
    passkeyRegisterVerify: (req) =>
      request<PasskeyRegisterVerifyResponse>('POST', '/auth/passkey/register/verify', {
        body: req,
      }),
    passkeyLoginOptions: (req) =>
      request<PasskeyLoginOptionsResponse>('POST', '/auth/passkey/login/options', { body: req }),
    passkeyLoginVerify: (req) =>
      request<PasskeyLoginVerifyResponse>('POST', '/auth/passkey/login/verify', { body: req }),
    listPasskeys: () => request<Passkey[]>('GET', '/auth/passkeys'),
    renamePasskey: (id, req) =>
      request<Passkey>('PATCH', `/auth/passkeys/${encodeURIComponent(id)}`, { body: req }),
    deletePasskey: (id) => request<void>('DELETE', `/auth/passkeys/${encodeURIComponent(id)}`),
    startGoogleSignIn: (redirect) =>
      openLink(`${baseUrl}${GOOGLE_START_PATH}${toQueryString({ redirect })}`),
    requestMagicLink: (req) =>
      request<MagicLinkResponse>('POST', '/auth/magic-link', { body: req }),
    followDevLink: (link) => openLink(link),
    logout: () => request<void>('POST', '/auth/logout'),
    me: () => request<MeResponse>('GET', '/me'),
    listOAuthGrants: () => request<OAuthGrantsResponse>('GET', '/oauth/grants'),
    revokeOAuthGrant: (id) => request<void>('DELETE', `/oauth/grants/${encodeURIComponent(id)}`),
    vaultStatus: (spaceId) =>
      request<VaultStatus>('GET', `/spaces/${encodeURIComponent(spaceId)}/vault`),
    connectGitHubVault: (spaceId, req) =>
      request<ConnectGitHubVaultResponse>(
        'POST',
        `/spaces/${encodeURIComponent(spaceId)}/vault/github`,
        { body: req },
      ),
    disconnectGitHubVault: (spaceId, opts = {}) =>
      request<DisconnectGitHubVaultResponse>(
        'DELETE',
        `/spaces/${encodeURIComponent(spaceId)}/vault/github`,
        opts.skipImport ? { query: { skip_import: 'true' } } : {},
      ),
    dashboard: () => request<DashboardResponse>('GET', '/dashboard'),
    listNotes: (params = {}) =>
      request<Page<NoteSummary>>('GET', '/notes', {
        query: {
          type: params.type,
          project: params.project,
          cursor: params.cursor,
          limit: params.limit,
        },
      }),
    getNote: (path) => request<NoteDetail>('GET', '/note', { query: { path } }),
    saveNote: (req) => request<SaveNoteResponse>('PUT', '/note', { body: req }),
    search: (params) =>
      request<SearchResponse>('GET', '/search', {
        query: {
          q: params.q,
          types: params.types?.length ? params.types.join(',') : undefined,
          project: params.project,
          limit: params.limit,
        },
      }),
    projects: (status) => request<ProjectsResponse>('GET', '/projects', { query: { status } }),
    listKeys: () => request<Page<ApiKey>>('GET', '/keys'),
    createKey: (req) => request<CreateKeyResponse>('POST', '/keys', { body: req }),
    revokeKey: (id) => request<void>('DELETE', `/keys/${encodeURIComponent(id)}`),
    connect: () => request<ConnectInfo>('GET', '/connect'),
    deviceRequest: (userCode) =>
      request<DeviceRequestInfo>('GET', `/auth/device/${encodeURIComponent(userCode)}`),
    approveDevice: async (req) => {
      await request<unknown>('POST', '/auth/device/approve', { body: req });
    },
  };
  if (opts.dev) return { ...client, dev: opts.dev };
  return client;
}
