import type { DeviceStartResponse } from '@second-brain/schema';
import { describe, expect, it } from 'vitest';
import { createApi } from '../src/api';
import { pollForToken } from '../src/device';
import { CliError, ExitCode } from '../src/errors';
import { API, apiKey, makeEnv, mockFetch, SECRET, type Reply } from './helpers';

const START: DeviceStartResponse = {
  device_code: 'dev_123',
  user_code: 'WDJB-MJHT',
  verification_uri: `${API}/device`,
  verification_uri_complete: `${API}/device?code=WDJB-MJHT`,
  interval: 5,
  expires_in: 600,
};

const SUCCESS: Reply = {
  status: 200,
  body: { key: apiKey(), secret: SECRET, api_url: API, mcp_url: `${API}/mcp` },
};

/** Replies in order; the last reply repeats. */
function sequence(...replies: (Reply | 'network-error')[]) {
  let i = 0;
  return () => replies[Math.min(i++, replies.length - 1)]!;
}

async function poll(replies: (Reply | 'network-error')[], start = START) {
  const env = await makeEnv();
  const { fetch, calls } = mockFetch({ 'POST /auth/device/token': sequence(...replies) });
  const sleeps: number[] = [];
  const events: unknown[] = [];
  let clock = 0;
  const result = pollForToken(createApi({ ...env.ctx, fetch }, API), start, {
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
    onEvent: (e) => events.push(e),
  });
  return { result, sleeps, events, calls, cleanup: env.cleanup };
}

describe('pollForToken', () => {
  it('waits `interval` between polls while authorization is pending, then returns the token', async () => {
    const pending: Reply = { status: 428, body: { error: 'authorization_pending' } };
    const t = await poll([pending, pending, SUCCESS]);
    const token = await t.result;
    expect(token.secret).toBe(SECRET);
    expect(t.sleeps).toEqual([5000, 5000, 5000]);
    expect(t.calls).toHaveLength(3);
    expect(t.calls[0]!.body).toEqual({ device_code: 'dev_123' });
    await t.cleanup();
  });

  it('also understands the RFC 8628 400 {error: authorization_pending} form', async () => {
    const t = await poll([{ status: 400, body: { error: 'authorization_pending' } }, SUCCESS]);
    await expect(t.result).resolves.toMatchObject({ secret: SECRET });
    await t.cleanup();
  });

  it('adds 5 seconds to the interval on slow_down and keeps it', async () => {
    const t = await poll([
      { status: 400, body: { error: 'slow_down' } },
      { status: 428, body: { error: 'authorization_pending' } },
      SUCCESS,
    ]);
    await t.result;
    expect(t.sleeps).toEqual([5000, 10000, 10000]);
    expect(t.events).toContainEqual({ type: 'slow_down', intervalS: 10 });
    await t.cleanup();
  });

  it('treats 429 like slow_down', async () => {
    const t = await poll([{ status: 429, body: { title: 'Too Many Requests' } }, SUCCESS]);
    await t.result;
    expect(t.sleeps).toEqual([5000, 10000]);
    await t.cleanup();
  });

  it('stops with LoginFailed when access is denied (403)', async () => {
    const t = await poll([{ status: 403, body: { error: 'access_denied' } }]);
    const err = await t.result.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(ExitCode.LoginFailed);
    expect((err as CliError).message).toMatch(/denied/);
    await t.cleanup();
  });

  it('stops with LoginFailed when the code expired (410)', async () => {
    const t = await poll([{ status: 410, body: { error: 'expired_token' } }]);
    await expect(t.result).rejects.toMatchObject({
      exitCode: ExitCode.LoginFailed,
      message: expect.stringMatching(/expired/),
    });
    await t.cleanup();
  });

  it('backs off exponentially on network errors and recovers', async () => {
    const t = await poll(['network-error', 'network-error', 'network-error', SUCCESS]);
    await expect(t.result).resolves.toMatchObject({ secret: SECRET });
    expect(t.sleeps).toEqual([5000, 10000, 20000, 40000]);
    expect(t.events.filter((e) => (e as { type: string }).type === 'retry')).toHaveLength(3);
    await t.cleanup();
  });

  it('caps the backoff at 60 seconds and treats 5xx as transient', async () => {
    const t = await poll([
      { status: 503 },
      { status: 503 },
      { status: 503 },
      { status: 503 },
      SUCCESS,
    ]);
    await t.result;
    expect(t.sleeps).toEqual([5000, 10000, 20000, 40000, 60000]);
    await t.cleanup();
  });

  it('gives up when the code expires while still pending', async () => {
    const t = await poll([{ status: 428, body: { error: 'authorization_pending' } }], {
      ...START,
      expires_in: 12,
    });
    await expect(t.result).rejects.toMatchObject({ exitCode: ExitCode.LoginFailed });
    // 5 s, 5 s, then only the 2 s that remain.
    expect(t.sleeps).toEqual([5000, 5000, 2000]);
    await t.cleanup();
  });

  it('surfaces unexpected client errors instead of polling forever', async () => {
    const t = await poll([{ status: 400, body: { error: 'invalid_grant', title: 'Bad code' } }]);
    await expect(t.result).rejects.toMatchObject({ status: 400 });
    await t.cleanup();
  });
});
