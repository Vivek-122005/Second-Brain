import type { DeviceStartResponse, DeviceTokenResponse } from '@second-brain/schema';
import { ApiError, NetworkError, type ApiClient } from './api';
import { CliError, ExitCode } from './errors';

/** RFC 8628 §3.5: on `slow_down` the client must add 5 seconds to its polling interval. */
const SLOW_DOWN_STEP_S = 5;
const MAX_BACKOFF_S = 60;

export interface PollOptions {
  sleep(ms: number): Promise<void>;
  now(): number;
  /** Called after each pending poll and on transient errors, for progress output. */
  onEvent?(event: PollEvent): void;
}

export type PollEvent =
  | { type: 'pending' }
  | { type: 'slow_down'; intervalS: number }
  | { type: 'retry'; reason: string; waitS: number };

/**
 * Polls `POST /auth/device/token` until the user approves, denies or the code expires.
 *
 * - `428 authorization_pending` (or the RFC 8628 `400 {error}` form): wait `interval` and retry.
 * - `slow_down` / `429`: permanently add 5 s to the interval.
 * - `403 access_denied`, `410 expired_token`: stop with a clear error.
 * - Network errors and 5xx: retry with exponential backoff (capped at 60 s) until expiry.
 */
export async function pollForToken(
  api: ApiClient,
  start: DeviceStartResponse,
  opts: PollOptions,
): Promise<DeviceTokenResponse> {
  let intervalS = Math.max(1, Number(start.interval) || 5);
  const deadline = opts.now() + Math.max(1, Number(start.expires_in) || 600) * 1000;
  let failures = 0;

  for (;;) {
    const remaining = deadline - opts.now();
    if (remaining <= 0) throw expired();
    const waitS = failures > 0 ? backoff(intervalS, failures) : intervalS;
    await opts.sleep(Math.min(waitS * 1000, remaining));
    if (opts.now() >= deadline) throw expired();

    try {
      return await api.deviceToken(start.device_code);
    } catch (err) {
      if (err instanceof NetworkError) {
        failures++;
        opts.onEvent?.({
          type: 'retry',
          reason: 'network error',
          waitS: backoff(intervalS, failures),
        });
        continue;
      }
      if (!(err instanceof ApiError)) throw err;

      const code = err.code;
      if (code === 'authorization_pending' || (err.status === 428 && !code)) {
        failures = 0;
        opts.onEvent?.({ type: 'pending' });
        continue;
      }
      if (code === 'slow_down' || err.status === 429) {
        failures = 0;
        intervalS += SLOW_DOWN_STEP_S;
        opts.onEvent?.({ type: 'slow_down', intervalS });
        continue;
      }
      if (code === 'access_denied' || err.status === 403) {
        throw new CliError(
          'Sign-in was denied in the browser.',
          ExitCode.LoginFailed,
          'Run `brain login` again if that was a mistake.',
        );
      }
      if (code === 'expired_token' || err.status === 410) throw expired();
      if (err.status >= 500) {
        failures++;
        opts.onEvent?.({
          type: 'retry',
          reason: `server error ${err.status}`,
          waitS: backoff(intervalS, failures),
        });
        continue;
      }
      throw err;
    }
  }
}

function backoff(intervalS: number, failures: number): number {
  return Math.min(MAX_BACKOFF_S, intervalS * 2 ** failures);
}

function expired(): CliError {
  return new CliError(
    'The sign-in code expired before it was approved.',
    ExitCode.LoginFailed,
    'Run `brain login` to get a new code.',
  );
}
