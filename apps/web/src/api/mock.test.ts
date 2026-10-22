import { describe, expect, it } from 'vitest';
import { ApiError } from './client';
import { createMockApi } from './mock';

describe('mock API', () => {
  it('serves the fixture vault with links and backlinks', async () => {
    const { api } = createMockApi();
    const note = await api.getNote('topics/rate-limiting.md');
    expect(note.title).toBe('Rate limiting');
    expect(note.type).toBe('topic');
    expect(note.links).toContainEqual({
      target: 'stripe-webhooks',
      path: 'topics/stripe-webhooks.md',
    });
    expect(note.backlinks.map((b) => b.path)).toContain('topics/idempotency.md');
  });

  it('saves with the current version and returns a new one', async () => {
    const { api } = createMockApi();
    const note = await api.getNote('inbox/ideas.md');
    const res = await api.saveNote({
      path: note.path,
      content: `${note.raw}\n- One more idea\n`,
      base_version: note.version,
    });
    expect(res.version).not.toBe(note.version);
    const after = await api.getNote(note.path);
    expect(after.raw).toContain('One more idea');
    expect(after.version).toBe(res.version);
  });

  it('rejects a stale base_version with 409 and keeps the newer text', async () => {
    const { api, server } = createMockApi();
    const note = await api.getNote('inbox/ideas.md');
    server.simulateRemoteEdit(note.path);

    const err = await api
      .saveNote({ path: note.path, content: 'mine', base_version: note.version })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(409);
    expect((await api.getNote(note.path)).raw).toContain('Edited on another device');
  });

  it('refuses to create over an existing note (base_version null)', async () => {
    const { api } = createMockApi();
    await expect(
      api.saveNote({ path: 'inbox/ideas.md', content: 'x', base_version: null }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('rejects writes outside the vault roots', async () => {
    const { api } = createMockApi();
    await expect(
      api.saveNote({ path: '../etc/passwd', content: 'x', base_version: null }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('hides superseded decisions from the dashboard', async () => {
    const { api } = createMockApi();
    const dash = await api.dashboard();
    const ids = dash.recent_decisions.map((d) => d.id);
    expect(ids).toContain('DEC-0004');
    expect(ids).not.toContain('DEC-0001');
    expect(dash.check.broken_links).toContainEqual({
      from: 'topics/design-system.md',
      target: 'typography-scale',
    });
  });

  it('finds notes by keyword and marks matches', async () => {
    const { api } = createMockApi();
    const res = await api.search({ q: 'idempotent', types: ['topic'] });
    expect(res.hits.length).toBeGreaterThan(0);
    expect(res.hits.every((h) => h.type === 'topic')).toBe(true);
    expect(res.hits[0]?.snippet).toMatch(/\*\*idempotent\*\*/i);
  });

  it('requires a session, and the dev magic link signs you in', async () => {
    const { api } = createMockApi({ signedIn: false });
    await expect(api.me()).rejects.toMatchObject({ status: 401 });
    const link = await api.requestMagicLink('alex@example.com');
    expect(link.dev_link).toBeTruthy();
    await api.followDevLink(link.dev_link ?? '');
    await expect(api.me()).resolves.toMatchObject({ user: { email: 'alex@example.com' } });
  });

  it('offers passkey, Google and magic link, and a passkey assertion signs you in', async () => {
    const { api } = createMockApi({ signedIn: false });
    await expect(api.authProviders()).resolves.toEqual({
      passkey: true,
      google: true,
      magic_link: true,
    });
    // Verifying without asking for options first is rejected (no pending challenge).
    const fake = { response: { id: 'cred-1' } } as unknown as Parameters<
      typeof api.passkeyLoginVerify
    >[0];
    await expect(api.passkeyLoginVerify(fake)).rejects.toMatchObject({ status: 400 });
    const options = await api.passkeyLoginOptions({});
    expect(options.challenge.length).toBeGreaterThan(20);
    await api.passkeyLoginVerify(fake);
    await expect(api.me()).resolves.toBeTruthy();
  });

  it('approving a device creates a key; the code then stops working', async () => {
    const { api } = createMockApi();
    const before = (await api.listKeys()).items.length;
    const info = await api.deviceRequest('WDJB-MJHT');
    expect(info.client).toBe('brain-cli');
    await api.approveDevice({ user_code: 'WDJB-MJHT', approve: true, scopes: ['read'] });
    const keys = (await api.listKeys()).items;
    expect(keys).toHaveLength(before + 1);
    expect(keys[0]?.scopes).toEqual(['read']);
    await expect(api.deviceRequest('WDJB-MJHT')).rejects.toMatchObject({ status: 404 });
  });
});
