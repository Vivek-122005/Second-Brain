import type {
  ConnectGitHubVaultResponse,
  DisconnectGitHubVaultResponse,
  NoteDetail,
  Page,
  NoteSummary,
  VaultStatus,
} from '@second-brain/schema';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hmacHex } from '../src/lib/crypto';
import { openSpaceSecret, sealSpaceSecret, vaultFor } from '../src/vault';
import { ManagedVaultStore } from '../src/vault/managed';
import { FakeGitHub, type FakePush } from './fake-github';
import { call, env, newUserWithKey } from './helpers';

let gh: FakeGitHub;
let n = 0;

beforeEach(() => {
  gh = new FakeGitHub();
  gh.install();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** A user with a key, their personal space id, and a fresh repo name + token. */
async function setup(opts: { scopes?: ('read' | 'write')[] } = {}) {
  const { user, secret } = await newUserWithKey(opts);
  const space = await env.DB.prepare('SELECT id FROM spaces WHERE owner_user_id = ?')
    .bind(user.id)
    .first<{ id: string }>();
  n += 1;
  return {
    user,
    secret,
    spaceId: space!.id,
    repo: `octo/notes-${n}`,
    token: `github_pat_test_${n}_${crypto.randomUUID()}`,
  };
}

function api(secret: string, method: string, path: string, body?: unknown) {
  return call(`/api/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function importNotes(secret: string, files: Record<string, string>) {
  const res = await api(secret, 'POST', '/import', {
    files: Object.entries(files).map(([path, content]) => ({ path, content })),
  });
  expect(res.status).toBe(200);
}

async function connect(
  ctx: Awaited<ReturnType<typeof setup>>,
  body: Record<string, unknown>,
): Promise<Response> {
  return api(ctx.secret, 'POST', `/spaces/${ctx.spaceId}/vault/github`, {
    repo: ctx.repo,
    token: ctx.token,
    ...body,
  });
}

async function connected(
  ctx: Awaited<ReturnType<typeof setup>>,
  body: Record<string, unknown>,
): Promise<ConnectGitHubVaultResponse> {
  const res = await connect(ctx, body);
  expect(res.status, await res.clone().text()).toBe(201);
  return (await res.json()) as ConnectGitHubVaultResponse;
}

function pushEvent(repo: string, p: FakePush, commits?: unknown[]) {
  return {
    ref: p.ref,
    before: p.before,
    after: p.after,
    created: false,
    deleted: false,
    forced: false,
    repository: { full_name: repo },
    commits: commits ?? [{ id: p.after, added: p.added, modified: p.modified, removed: p.removed }],
  };
}

async function deliver(
  spaceId: string,
  secret: string,
  event: string,
  payload: unknown,
  opts: { delivery?: string; signature?: string } = {},
) {
  const body = JSON.stringify(payload);
  return call(`/webhooks/github/${spaceId}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': event,
      'x-github-delivery': opts.delivery ?? crypto.randomUUID(),
      'x-hub-signature-256': opts.signature ?? `sha256=${await hmacHex(secret, body)}`,
    },
    body,
  });
}

/** Writes a note through the REST API, sending the current version as the base. */
async function saveNote(secret: string, path: string, content: string) {
  const current = await api(secret, 'GET', `/note?path=${encodeURIComponent(path)}`);
  const base = current.status === 200 ? ((await current.json()) as NoteDetail).version : null;
  return api(secret, 'PUT', '/note', { path, content, base_version: base });
}

async function notePaths(secret: string): Promise<string[]> {
  const res = await api(secret, 'GET', '/notes?limit=200');
  return ((await res.json()) as Page<NoteSummary>).items.map((i) => i.path).sort();
}

async function noteBody(secret: string, path: string): Promise<string> {
  const res = await api(secret, 'GET', `/note?path=${encodeURIComponent(path)}`);
  expect(res.status).toBe(200);
  return ((await res.json()) as NoteDetail).raw;
}

async function indexedSha(spaceId: string, path: string) {
  const row = await env.DB.prepare('SELECT indexed_sha FROM notes WHERE space_id = ? AND path = ?')
    .bind(spaceId, path)
    .first<{ indexed_sha: string }>();
  return row?.indexed_sha ?? null;
}

const NOTE = (title: string, body = 'Body.') =>
  `---\ntype: topic\ntitle: ${title}\n---\n\n${body}\n`;

describe('token encryption', () => {
  it('round-trips with AES-GCM and binds the ciphertext to the space and column', async () => {
    const sealed = await sealSpaceSecret(env, 'spc_a', 'vault_token', 'github_pat_secret');
    expect(sealed).toMatch(/^v1\./);
    expect(sealed).not.toContain('github_pat_secret');
    expect(await openSpaceSecret(env, 'spc_a', 'vault_token', sealed)).toBe('github_pat_secret');
    await expect(openSpaceSecret(env, 'spc_b', 'vault_token', sealed)).rejects.toThrow();
    await expect(openSpaceSecret(env, 'spc_a', 'webhook_secret', sealed)).rejects.toThrow();
    // A fresh IV every time.
    expect(await sealSpaceSecret(env, 'spc_a', 'vault_token', 'github_pat_secret')).not.toBe(
      sealed,
    );
  });

  it('stores only ciphertext after connect, and the vault decrypts it', async () => {
    const ctx = await setup();
    gh.createRepo(ctx.repo, { token: ctx.token });
    await connected(ctx, { direction: 'push_managed' });
    const row = await env.DB.prepare('SELECT * FROM spaces WHERE id = ?').bind(ctx.spaceId).first<{
      vault_token_enc: string;
      webhook_secret_enc: string;
      vault_provider: 'github';
      vault_repo: string;
      vault_branch: string;
      id: string;
    }>();
    expect(row!.vault_token_enc).not.toContain(ctx.token);
    expect(await openSpaceSecret(env, ctx.spaceId, 'vault_token', row!.vault_token_enc)).toBe(
      ctx.token,
    );
    const vault = await vaultFor(env, row!);
    expect(vault.provider).toBe('github');
    expect(await vault.head()).toBe(null); // nothing exported yet: the repo is still empty
  });
});

describe('connect validation', () => {
  it('rejects malformed input', async () => {
    const ctx = await setup();
    const res = await connect(ctx, { repo: 'not-a-repo', direction: 'push_managed' });
    expect(res.status).toBe(400);
    expect(await connect(ctx, { direction: 'sideways' })).toHaveProperty('status', 400);
  });

  it('reports a rejected token, an unreachable repo and a missing branch', async () => {
    const ctx = await setup();
    gh.createRepo(ctx.repo, { token: ctx.token, files: { 'topics/a.md': NOTE('A') } });

    const bad = await connect(ctx, { token: 'github_pat_unknown_x', direction: 'adopt_repo' });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { title: string }).title).toBe('GitHub rejected the token');

    const other = await setup();
    gh.createRepo(other.repo, { token: other.token });
    const unreachable = await connect(ctx, { token: other.token, direction: 'adopt_repo' });
    expect(unreachable.status).toBe(400);
    expect(((await unreachable.json()) as { title: string }).title).toBe('Repository not found');

    const branch = await connect(ctx, { branch: 'nope', direction: 'adopt_repo' });
    expect(branch.status).toBe(400);
    expect(((await branch.json()) as { title: string }).title).toBe('Nothing to adopt');

    const readOnly = await setup();
    gh.createRepo(readOnly.repo, { token: readOnly.token, canWrite: false });
    expect((await connect(readOnly, { direction: 'push_managed' })).status).toBe(400);

    // Nothing switched.
    const status = (await (
      await api(ctx.secret, 'GET', `/spaces/${ctx.spaceId}/vault`)
    ).json()) as VaultStatus;
    expect(status).toMatchObject({ provider: 'managed', repo: null, webhook: null });
  });

  it('is limited to the space owner with a write-capable key', async () => {
    const owner = await setup();
    const stranger = await setup();
    gh.createRepo(owner.repo, { token: owner.token });
    const res = await api(stranger.secret, 'POST', `/spaces/${owner.spaceId}/vault/github`, {
      repo: owner.repo,
      token: owner.token,
      direction: 'push_managed',
    });
    expect(res.status).toBe(404);
    expect((await api(stranger.secret, 'GET', `/spaces/${owner.spaceId}/vault`)).status).toBe(404);

    const reader = await setup({ scopes: ['read'] });
    gh.createRepo(reader.repo, { token: reader.token });
    expect((await connect(reader, { direction: 'push_managed' })).status).toBe(403);
    expect(gh.log).toEqual([]); // refused before any GitHub call
  });

  it('asks for confirmation before overwriting notes on either side', async () => {
    const ctx = await setup();
    await importNotes(ctx.secret, { 'topics/mine.md': NOTE('Mine') });
    gh.createRepo(ctx.repo, { token: ctx.token, files: { 'topics/theirs.md': NOTE('Theirs') } });

    const push = await connect(ctx, { direction: 'push_managed' });
    expect(push.status).toBe(409);
    expect(await push.json()).toMatchObject({ repo_notes: 1 });

    const adopt = await connect(ctx, { direction: 'adopt_repo' });
    expect(adopt.status).toBe(409);
    expect(await adopt.json()).toMatchObject({ managed_notes: 1 });
  });

  it('refuses to connect twice', async () => {
    const ctx = await setup();
    gh.createRepo(ctx.repo, { token: ctx.token });
    await connected(ctx, { direction: 'push_managed' });
    expect((await connect(ctx, { direction: 'push_managed' })).status).toBe(409);
  });
});

describe('push_managed', () => {
  it('exports the managed vault to an empty repo as one commit and creates the webhook', async () => {
    const ctx = await setup();
    await importNotes(ctx.secret, {
      'projects/garden.md': '---\ntype: project\ntitle: Garden\n---\n\nPlant [[topics/soil]].\n',
      'topics/soil.md': NOTE('Soil', 'Loam is best.'),
      'inbox/idea.md': NOTE('Idea'),
    });
    gh.createRepo(ctx.repo, { token: ctx.token, canHooks: true });

    const r = await connected(ctx, { direction: 'push_managed' });
    expect(r).toMatchObject({ direction: 'push_managed', exported: 3, indexed: 3 });
    expect(gh.history(ctx.repo)).toEqual([r.commit_sha]); // exactly one commit on the branch
    expect(Object.keys(gh.files(ctx.repo)).sort()).toEqual([
      'inbox/idea.md',
      'projects/garden.md',
      'topics/soil.md',
    ]);
    expect(gh.files(ctx.repo)['topics/soil.md']).toBe(NOTE('Soil', 'Loam is best.'));

    expect(r.webhook).toMatchObject({
      payload_url: `http://app.test/webhooks/github/${ctx.spaceId}`,
      content_type: 'application/json',
      events: ['push'],
      created: true,
      detail: null,
    });
    expect(r.webhook.secret.length).toBeGreaterThanOrEqual(32);
    const hook = gh.repo(ctx.repo).hooks[0]!;
    expect(hook.config).toMatchObject({ url: r.webhook.payload_url, secret: r.webhook.secret });

    expect(r.vault).toMatchObject({
      provider: 'github',
      repo: ctx.repo,
      branch: 'main',
      last_synced_sha: r.commit_sha,
      last_sync_error: null,
      webhook: { configured: true, auto_created: true },
    });
    expect(await notePaths(ctx.secret)).toEqual([
      'inbox/idea.md',
      'projects/garden.md',
      'topics/soil.md',
    ]);

    // Later saves go to GitHub as fast-forward commits.
    const put = await saveNote(ctx.secret, 'topics/soil.md', NOTE('Soil', 'Clay holds water.'));
    expect(put.status).toBe(200);
    expect(gh.files(ctx.repo)['topics/soil.md']).toContain('Clay holds water.');
    expect(gh.history(ctx.repo)).toHaveLength(2);

    const audit = await env.DB.prepare(
      "SELECT metadata FROM audit_log WHERE space_id = ? AND action = 'vault.github.connect'",
    )
      .bind(ctx.spaceId)
      .first<{ metadata: string }>();
    expect(JSON.parse(audit!.metadata)).toMatchObject({ exported: 3, webhook_created: true });
    expect(audit!.metadata).not.toContain(ctx.token);
  });

  it('exports on top of a confirmed non-empty repo and falls back to a manual webhook', async () => {
    const ctx = await setup();
    await importNotes(ctx.secret, { 'topics/mine.md': NOTE('Mine') });
    gh.createRepo(ctx.repo, {
      token: ctx.token,
      defaultBranch: 'trunk',
      files: { 'README.md': '# Notes\n', 'topics/theirs.md': NOTE('Theirs'), 'img/a.png': 'x' },
    });
    const r = await connected(ctx, { direction: 'push_managed', confirm_overwrite: true });
    expect(r.vault.branch).toBe('trunk');
    expect(r.webhook.created).toBe(false);
    expect(r.webhook.detail).toContain('Webhooks');
    expect(r.vault.webhook).toMatchObject({ configured: false, auto_created: false });
    expect(Object.keys(gh.files(ctx.repo, 'trunk')).sort()).toEqual([
      'README.md',
      'img/a.png',
      'topics/mine.md',
      'topics/theirs.md',
    ]);
    expect(await notePaths(ctx.secret)).toEqual([
      'README.md',
      'topics/mine.md',
      'topics/theirs.md',
    ]);
  });
});

describe('adopt_repo', () => {
  it("imports the repo's Markdown and switches the space to GitHub", async () => {
    const ctx = await setup();
    await importNotes(ctx.secret, { 'topics/old.md': NOTE('Old') });
    gh.createRepo(ctx.repo, {
      token: ctx.token,
      files: {
        'projects/x.md': '---\ntype: project\ntitle: X\n---\n\nGoal.\n',
        'topics/a.md': NOTE('A', 'Alpha.'),
        'assets/pic.png': 'binary',
        '.obsidian/workspace.md': 'hidden',
      },
    });
    const r = await connected(ctx, { direction: 'adopt_repo', confirm_overwrite: true });
    expect(r).toMatchObject({ exported: 0, indexed: 2, commit_sha: null });
    expect(r.vault.last_synced_sha).toBe(gh.repo(ctx.repo).refs.get('main'));
    expect(await notePaths(ctx.secret)).toEqual(['projects/x.md', 'topics/a.md']);
    expect(await noteBody(ctx.secret, 'topics/a.md')).toContain('Alpha.');
    // Adopting never writes to the repository.
    expect(gh.log.filter((l) => !l.startsWith('GET') && !l.includes('/hooks'))).toEqual([]);
  });
});

describe('webhook', () => {
  async function adopted(canHooks = false) {
    const ctx = await setup();
    gh.createRepo(ctx.repo, {
      token: ctx.token,
      canHooks,
      files: {
        'projects/x.md': '---\ntype: project\ntitle: X\n---\n\nGoal.\n',
        'topics/a.md': NOTE('A', 'Alpha.'),
        'topics/b.md': NOTE('B', 'Beta.'),
      },
    });
    const r = await connected(ctx, { direction: 'adopt_repo' });
    gh.log = [];
    return { ...ctx, hookSecret: r.webhook.secret };
  }

  it('rejects missing, wrong and foreign signatures', async () => {
    const ctx = await adopted();
    const p = gh.push(ctx.repo, 'main', { 'topics/a.md': NOTE('A', 'Changed.') });
    const payload = pushEvent(ctx.repo, p);
    expect(
      (await deliver(ctx.spaceId, ctx.hookSecret, 'push', payload, { signature: '' })).status,
    ).toBe(401);
    expect(
      (await deliver(ctx.spaceId, ctx.hookSecret, 'push', payload, { signature: 'sha256=00' }))
        .status,
    ).toBe(401);
    expect((await deliver(ctx.spaceId, 'some-other-secret', 'push', payload)).status).toBe(401);
    expect((await deliver('spc_nope', ctx.hookSecret, 'push', payload)).status).toBe(404);
    expect(gh.log).toEqual([]);
    expect(await noteBody(ctx.secret, 'topics/a.md')).toContain('Alpha.');
  });

  it('answers ping and marks the webhook as configured', async () => {
    const ctx = await adopted();
    let status = (await (
      await api(ctx.secret, 'GET', `/spaces/${ctx.spaceId}/vault`)
    ).json()) as VaultStatus;
    expect(status.webhook?.configured).toBe(false);
    const res = await deliver(ctx.spaceId, ctx.hookSecret, 'ping', { zen: 'Keep it simple.' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'pong' });
    status = (await (
      await api(ctx.secret, 'GET', `/spaces/${ctx.spaceId}/vault`)
    ).json()) as VaultStatus;
    expect(status.webhook).toMatchObject({ configured: true, auto_created: false });
    expect(status.webhook?.last_delivery_at).toBeTruthy();
  });

  it('re-indexes only the changed Markdown paths after answering 202', async () => {
    const ctx = await adopted();
    const before = await indexedSha(ctx.spaceId, 'projects/x.md');
    const p = gh.push(ctx.repo, 'main', {
      'topics/a.md': NOTE('A', 'Alpha two.'),
      'topics/b.md': null,
      'inbox/new.md': NOTE('New', 'Fresh idea.'),
      'assets/pic.png': 'binary',
    });
    const res = await deliver(ctx.spaceId, ctx.hookSecret, 'push', pushEvent(ctx.repo, p));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: 'accepted' });

    expect(gh.log.sort()).toEqual([
      'GET /contents/inbox/new.md',
      'GET /contents/topics/a.md',
      'GET /contents/topics/b.md',
    ]);
    expect(await notePaths(ctx.secret)).toEqual(['inbox/new.md', 'projects/x.md', 'topics/a.md']);
    expect(await noteBody(ctx.secret, 'topics/a.md')).toContain('Alpha two.');
    expect(await indexedSha(ctx.spaceId, 'topics/a.md')).toBe(p.after);
    expect(await indexedSha(ctx.spaceId, 'projects/x.md')).toBe(before); // untouched

    const status = (await (
      await api(ctx.secret, 'GET', `/spaces/${ctx.spaceId}/vault`)
    ).json()) as VaultStatus;
    expect(status.last_synced_sha).toBe(p.after);
    const audit = await env.DB.prepare(
      "SELECT target, metadata FROM audit_log WHERE space_id = ? AND action = 'vault.github.sync'",
    )
      .bind(ctx.spaceId)
      .first<{ target: string; metadata: string }>();
    expect(audit!.target).toBe(p.after);
    expect(JSON.parse(audit!.metadata)).toMatchObject({
      trigger: 'webhook',
      mode: 'incremental',
      indexed: 2,
      removed: 1,
    });
  });

  it('dedupes deliveries by X-GitHub-Delivery', async () => {
    const ctx = await adopted();
    const p = gh.push(ctx.repo, 'main', { 'topics/a.md': NOTE('A', 'Once.') });
    const payload = pushEvent(ctx.repo, p);
    const first = await deliver(ctx.spaceId, ctx.hookSecret, 'push', payload, { delivery: 'd-1' });
    expect(first.status).toBe(202);
    gh.log = [];
    // Pretend the index fell behind so only dedupe can stop a second sync.
    await env.DB.prepare('UPDATE sync_state SET last_indexed_sha = ? WHERE space_id = ?')
      .bind(p.before, ctx.spaceId)
      .run();
    const again = await deliver(ctx.spaceId, ctx.hookSecret, 'push', payload, { delivery: 'd-1' });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ status: 'duplicate' });
    expect(gh.log).toEqual([]);
  });

  it('compares from the indexed commit when a push was missed or the list is truncated', async () => {
    const ctx = await adopted();
    gh.push(ctx.repo, 'main', { 'topics/missed.md': NOTE('Missed') }); // webhook never arrived
    const p = gh.push(ctx.repo, 'main', { 'topics/a.md': NOTE('A', 'Latest.') });
    const res = await deliver(ctx.spaceId, ctx.hookSecret, 'push', pushEvent(ctx.repo, p));
    expect(res.status).toBe(202);
    expect(gh.log.some((l) => l.startsWith('GET /compare/'))).toBe(true);
    expect(gh.log.some((l) => l.startsWith('GET /git/trees'))).toBe(false); // no full rebuild
    expect(await notePaths(ctx.secret)).toContain('topics/missed.md');
    expect(await noteBody(ctx.secret, 'topics/a.md')).toContain('Latest.');

    gh.log = [];
    const q = gh.push(ctx.repo, 'main', { 'topics/b.md': NOTE('B', 'Big push.') });
    const truncated = pushEvent(
      ctx.repo,
      q,
      Array.from({ length: 20 }, (_, i) => ({ id: `c${i}`, added: [], modified: [], removed: [] })),
    );
    expect((await deliver(ctx.spaceId, ctx.hookSecret, 'push', truncated)).status).toBe(202);
    expect(gh.log.some((l) => l.startsWith('GET /compare/'))).toBe(true);
    expect(await noteBody(ctx.secret, 'topics/b.md')).toContain('Big push.');
  });

  it('ignores other branches and skips pushes that are already indexed (our own commits)', async () => {
    const ctx = await adopted();
    const side = gh.push(ctx.repo, 'feature', { 'topics/side.md': NOTE('Side') });
    const other = await deliver(ctx.spaceId, ctx.hookSecret, 'push', pushEvent(ctx.repo, side));
    expect(await other.json()).toEqual({ status: 'ignored', reason: 'branch' });

    const put = await saveNote(ctx.secret, 'topics/a.md', NOTE('A', 'Written by an agent.'));
    expect(put.status).toBe(200);
    const sha = ((await put.json()) as { commit_sha: string }).commit_sha;
    gh.log = [];
    const own = await deliver(ctx.spaceId, ctx.hookSecret, 'push', {
      ...pushEvent(ctx.repo, {
        ref: 'refs/heads/main',
        before: gh.repo(ctx.repo).commits.get(sha)!.parents[0]!,
        after: sha,
        added: [],
        modified: ['topics/a.md'],
        removed: [],
      }),
    });
    expect(own.status).toBe(202);
    expect(await own.json()).toEqual({ status: 'skipped', reason: 'already_indexed' });
    expect(gh.log).toEqual([]);
    expect(await notePaths(ctx.secret)).not.toContain('topics/side.md');
  });
});

describe('drift check', () => {
  it('catches up a missed push when the space is read and the last check is stale', async () => {
    const ctx = await setup();
    gh.createRepo(ctx.repo, { token: ctx.token, files: { 'topics/a.md': NOTE('A') } });
    await connected(ctx, { direction: 'adopt_repo' });
    gh.push(ctx.repo, 'main', { 'topics/late.md': NOTE('Late') });

    gh.log = [];
    await api(ctx.secret, 'GET', '/notes'); // fresh check: no GitHub call
    expect(gh.log).toEqual([]);

    await env.DB.prepare('UPDATE sync_state SET last_checked_at = ? WHERE space_id = ?')
      .bind(Date.now() - 11 * 60 * 1000, ctx.spaceId)
      .run();
    await api(ctx.secret, 'GET', '/notes'); // triggers the check in waitUntil
    expect(gh.log[0]).toBe('GET /git/ref/heads/main');
    expect(await notePaths(ctx.secret)).toEqual(['topics/a.md', 'topics/late.md']);
  });
});

describe('disconnect', () => {
  it('imports the latest files back into the managed vault with no data loss', async () => {
    const ctx = await setup();
    await importNotes(ctx.secret, {
      'topics/a.md': NOTE('A', 'Alpha.'),
      'topics/b.md': NOTE('B', 'Beta.'),
    });
    gh.createRepo(ctx.repo, { token: ctx.token, canHooks: true });
    await connected(ctx, { direction: 'push_managed' });
    // Edits made in Obsidian while connected (the webhook happened to be missed).
    gh.push(ctx.repo, 'main', {
      'topics/a.md': NOTE('A', 'Edited in Obsidian.'),
      'topics/b.md': null,
      'inbox/c.md': NOTE('C', 'New in Obsidian.'),
    });

    const res = await api(ctx.secret, 'DELETE', `/spaces/${ctx.spaceId}/vault/github`);
    expect(res.status).toBe(200);
    const r = (await res.json()) as DisconnectGitHubVaultResponse;
    expect(r).toMatchObject({ imported: 2, removed: 1, webhook_removed: true });
    expect(r.vault).toMatchObject({ provider: 'managed', repo: null, branch: null, webhook: null });
    expect(gh.repo(ctx.repo).hooks).toEqual([]);

    const managed = await new ManagedVaultStore(env.DB, ctx.spaceId).readAll();
    expect(Object.fromEntries(managed.map((f) => [f.path, f.content]))).toEqual(gh.files(ctx.repo));
    expect(await notePaths(ctx.secret)).toEqual(['inbox/c.md', 'topics/a.md']);
    expect(await noteBody(ctx.secret, 'topics/a.md')).toContain('Edited in Obsidian.');

    const row = await env.DB.prepare(
      'SELECT vault_provider, vault_token_enc, webhook_secret_enc FROM spaces WHERE id = ?',
    )
      .bind(ctx.spaceId)
      .first();
    expect(row).toEqual({
      vault_provider: 'managed',
      vault_token_enc: null,
      webhook_secret_enc: null,
    });

    // Writes are managed again: GitHub is no longer touched.
    gh.log = [];
    const put = await saveNote(ctx.secret, 'topics/d.md', NOTE('D'));
    expect(put.status).toBe(200);
    expect(gh.log).toEqual([]);
    const actions = await env.DB.prepare(
      "SELECT action FROM audit_log WHERE space_id = ? AND action LIKE 'vault.github.%' ORDER BY at",
    )
      .bind(ctx.spaceId)
      .all<{ action: string }>();
    expect(actions.results.map((a) => a.action)).toEqual([
      'vault.github.connect',
      'vault.github.disconnect',
    ]);
  });

  it('refuses when the space is not connected', async () => {
    const ctx = await setup();
    expect((await api(ctx.secret, 'DELETE', `/spaces/${ctx.spaceId}/vault/github`)).status).toBe(
      409,
    );
  });
});
