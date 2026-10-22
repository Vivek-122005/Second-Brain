import { describe, expect, it, vi } from 'vitest';
import { ApiError, createHttpClient, parseErrorResponse } from './client';

function problem(status: number, body: unknown, type = 'application/problem+json'): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': type } });
}

describe('parseErrorResponse', () => {
  it('reads RFC 9457 problem+json, including field errors', async () => {
    const err = await parseErrorResponse(
      problem(422, {
        type: 'https://example.com/problems/validation',
        title: 'Invalid input',
        status: 422,
        detail: 'Enter a valid email address.',
        errors: [{ path: 'email', message: 'Invalid email' }, { bogus: true }],
      }),
    );
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(422);
    expect(err.title).toBe('Invalid input');
    expect(err.detail).toBe('Enter a valid email address.');
    expect(err.type).toBe('https://example.com/problems/validation');
    expect(err.errors).toEqual([{ path: 'email', message: 'Invalid email' }]);
  });

  it('flags conflicts and auth failures', async () => {
    const conflict = await parseErrorResponse(
      problem(409, { type: 'x', title: 'Conflict', status: 409 }),
    );
    expect(conflict.isConflict).toBe(true);
    const unauth = await parseErrorResponse(
      problem(401, { type: 'x', title: 'Nope', status: 401 }),
    );
    expect(unauth.isUnauthorized).toBe(true);
  });

  it('accepts plain JSON errors like the device-token endpoint', async () => {
    const err = await parseErrorResponse(
      problem(403, { error: 'access_denied' }, 'application/json'),
    );
    expect(err.status).toBe(403);
    expect(err.title).toBe('access_denied');
  });

  it('falls back to a status title when the body is not JSON', async () => {
    const res = new Response('<html>Bad gateway</html>', {
      status: 502,
      headers: { 'content-type': 'text/html' },
    });
    const err = await parseErrorResponse(res);
    expect(err.status).toBe(502);
    expect(err.title).toBe('Bad gateway');
    expect(err.detail).toBeUndefined();
  });
});

describe('createHttpClient', () => {
  it('sends credentials, JSON bodies and query strings to /api/v1', async () => {
    const fetch = vi.fn(async (_input: string, _init?: RequestInit) =>
      Response.json({ hits: [], mode: 'keyword' }),
    );
    const api = createHttpClient({ baseUrl: 'https://brain.example.com/', fetch });
    await api.search({ q: 'rate limit', types: ['topic', 'project'] });
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe('https://brain.example.com/api/v1/search?q=rate+limit&types=topic%2Cproject');
    expect(init?.credentials).toBe('include');

    fetch.mockResolvedValueOnce(
      Response.json({ path: 'inbox/a.md', version: 'v2', commit_sha: 'abc' }),
    );
    await api.saveNote({ path: 'inbox/a.md', content: 'x', base_version: 'v1' });
    const [, saveInit] = fetch.mock.calls[1] ?? [];
    expect(saveInit?.method).toBe('PUT');
    expect(JSON.parse(String(saveInit?.body))).toEqual({
      path: 'inbox/a.md',
      content: 'x',
      base_version: 'v1',
    });
  });

  it('sends the post-sign-in destination with a magic-link request', async () => {
    const fetch = vi.fn(async (_input: string, _init?: RequestInit) =>
      Response.json({ sent: true }, { status: 202 }),
    );
    const api = createHttpClient({ fetch });
    await api.requestMagicLink({ email: 'alex@example.com', next: '/oauth/authorize?client_id=c' });
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe('/api/v1/auth/magic-link');
    expect(JSON.parse(String(init?.body))).toEqual({
      email: 'alex@example.com',
      next: '/oauth/authorize?client_id=c',
    });
  });

  it('keeps problem extension members and sends skip_import on disconnect', async () => {
    const fetch = vi.fn(async (_input: string, _init?: RequestInit) =>
      problem(409, { type: 'x', title: 'Conflict', status: 409, detail: 'd', repo_notes: 12 }),
    );
    const api = createHttpClient({ fetch });
    await expect(
      api.connectGitHubVault('spc_1', {
        repo: 'a/b',
        token: 'github_pat_x',
        direction: 'push_managed',
      }),
    ).rejects.toMatchObject({ status: 409, extensions: { repo_notes: 12 } });

    fetch.mockResolvedValueOnce(Response.json({ imported: 0 }));
    await api.disconnectGitHubVault('spc_1', { skipImport: true });
    const [url, init] = fetch.mock.calls[1] ?? [];
    expect(url).toBe('/api/v1/spaces/spc_1/vault/github?skip_import=true');
    expect(init?.method).toBe('DELETE');
  });

  it('handles 204 No Content', async () => {
    const api = createHttpClient({ fetch: async () => new Response(null, { status: 204 }) });
    await expect(api.revokeKey('key_1')).resolves.toBeUndefined();
  });

  it('throws a typed ApiError for problem responses', async () => {
    const api = createHttpClient({
      fetch: async () =>
        problem(404, { type: 'x', title: 'Not found', status: 404, detail: 'No note' }),
    });
    await expect(api.getNote('nope.md')).rejects.toMatchObject({
      name: 'ApiError',
      status: 404,
      detail: 'No note',
    });
  });

  it('turns network failures into status 0', async () => {
    const api = createHttpClient({
      fetch: async () => {
        throw new TypeError('Failed to fetch');
      },
    });
    await expect(api.me()).rejects.toMatchObject({ status: 0, title: 'Network error' });
  });
});
