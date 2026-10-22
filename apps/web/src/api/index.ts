import { createHttpClient, type ApiClient } from './client';

export { ApiError, isApiError } from './client';
export type { ApiClient } from './client';

export function isMockEnabled(): boolean {
  return import.meta.env.VITE_MOCK_API === 'true';
}

/**
 * Creates the API client for this build. The mock is imported lazily so it (and its fixtures)
 * never ship in the production bundle unless mock mode is switched on.
 */
export async function createApi(): Promise<ApiClient> {
  if (isMockEnabled()) {
    const { createMockApi } = await import('./mock');
    return createMockApi({ latencyMs: 180, persistSession: true }).api;
  }
  const baseUrl = (import.meta.env.VITE_API_URL as string | undefined) ?? '';
  return createHttpClient({ baseUrl });
}
