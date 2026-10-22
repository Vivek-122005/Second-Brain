import type {
  ApiKey,
  CreateKeyRequest,
  CreateKeyResponse,
  DeviceStartRequest,
  DeviceStartResponse,
  DeviceTokenResponse,
  MeResponse,
  Page,
  ProblemDetails,
} from '@second-brain/schema';
import type { Ctx } from './context';
import { CliError, ExitCode } from './errors';
import { VERSION } from './version';

/** The server answered with a non-2xx status. */
export class ApiError extends CliError {
  constructor(
    readonly status: number,
    /** RFC 9457 problem, or the RFC 8628 `{ error }` body used by the device token endpoint. */
    readonly body: (Partial<ProblemDetails> & { error?: string }) | undefined,
    message: string,
  ) {
    super(message, status === 401 ? ExitCode.Auth : ExitCode.Error);
    this.name = 'ApiError';
  }

  /** Machine-readable error code: `body.error`, else the problem `type` slug. */
  get code(): string | undefined {
    if (this.body?.error) return this.body.error;
    const t = this.body?.type;
    return t ? t.split('/').pop() : undefined;
  }
}

/** The request never got an HTTP response (DNS, refused, TLS, timeout). */
export class NetworkError extends CliError {
  constructor(
    readonly url: string,
    cause: unknown,
  ) {
    const why =
      cause instanceof Error
        ? (cause.cause as Error | undefined)?.message || cause.message
        : String(cause);
    super(
      `Could not reach ${new URL(url).origin} (${why}).`,
      ExitCode.Network,
      'Check the URL and your connection, or pass --api <url>.',
    );
    this.name = 'NetworkError';
  }
}

const TIMEOUT_MS = 15_000;

export interface ApiClient {
  readonly baseUrl: string;
  request<T>(method: string, path: string, body?: unknown): Promise<T>;
  startDevice(body: DeviceStartRequest): Promise<DeviceStartResponse>;
  deviceToken(deviceCode: string): Promise<DeviceTokenResponse>;
  me(): Promise<MeResponse>;
  listKeys(): Promise<ApiKey[]>;
  createKey(body: Partial<CreateKeyRequest> & { label: string }): Promise<CreateKeyResponse>;
  revokeKey(id: string): Promise<void>;
}

export function createApi(ctx: Ctx, baseUrl: string, secret?: string): ApiClient {
  const userAgent = `second-brain-cli/${VERSION} (node ${process.versions.node}; ${ctx.platform})`;

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${baseUrl}/api/v1${path}`;
    const headers: Record<string, string> = {
      accept: 'application/json, application/problem+json',
      'user-agent': userAgent,
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (secret) headers.authorization = `Bearer ${secret}`;

    let res: Response;
    try {
      res = await ctx.fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: 'error',
      });
    } catch (err) {
      throw new NetworkError(url, err);
    }

    const text = await res.text().catch(() => '');
    let json: unknown;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }
    if (!res.ok) {
      const problem = (json && typeof json === 'object' ? json : undefined) as
        (Partial<ProblemDetails> & { error?: string }) | undefined;
      const detail = problem?.detail ?? problem?.title ?? problem?.error;
      const message =
        res.status === 401
          ? 'The server rejected the stored API key (revoked or expired).'
          : `${method} ${path} failed: ${res.status}${detail ? ` ${detail}` : ` ${res.statusText}`}`;
      throw new ApiError(res.status, problem, message);
    }
    return json as T;
  }

  return {
    baseUrl,
    request,
    startDevice: (body) => request('POST', '/auth/device', body),
    deviceToken: (device_code) => request('POST', '/auth/device/token', { device_code }),
    me: () => request('GET', '/me'),
    async listKeys() {
      const items: ApiKey[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 50; page++) {
        const q: string = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
        const res: Page<ApiKey> = await request('GET', `/keys${q}`);
        items.push(...(res.items ?? []));
        cursor = res.next_cursor ?? null;
        if (!cursor) break;
      }
      return items;
    },
    createKey: (body) => request('POST', '/keys', body),
    revokeKey: async (id) => {
      await request('DELETE', `/keys/${encodeURIComponent(id)}`);
    },
  };
}
