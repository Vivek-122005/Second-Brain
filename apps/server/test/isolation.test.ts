/* eslint-disable @typescript-eslint/no-explicit-any -- tests assert on loosely-typed payloads */
import type { Grant, Invitation } from '@second-brain/schema';
import { describe, expect, it } from 'vitest';
import { createKey } from '../src/auth/keys';
import { createSession } from '../src/auth/sessions';
import { upsertUserByEmail } from '../src/services/spaces';
import { call, env, mcp, newUserWithKey } from './helpers';

/**
 * Tenant-isolation suite (security.md §6, FR-SHR-02..04): what user B can and cannot reach in
 * user A's space, through every read and write path, as grants are created, accepted, narrowed
 * to a project, hidden from agents and revoked.
 */

const ORIGIN = 'http://app.test';

async function person(scopes: ('read' | 'write')[] = ['read', 'write']) {
  const u = await newUserWithKey({ scopes });
  const session = await createSession(env.DB, u.user.id);
  const space = (await env.DB.prepare('SELECT id FROM spaces WHERE owner_user_id = ?')
    .bind(u.user.id)
    .first<{ id: string }>())!.id;
  return { ...u, space, cookie: `sb_session=${session.token}` };
}
type Person = Awaited<ReturnType<typeof person>>;

/** REST call as a web session (`cookie`) or a key (`Bearer`). */
async function rest(
  who: { cookie: string } | { secret: string },
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if ('cookie' in who) {
    headers.cookie = who.cookie;
    headers.origin = ORIGIN;
  } else headers.authorization = `Bearer ${who.secret}`;
  const res = await call(`/api/v1${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const asWeb = (p: Person) => ({ cookie: p.cookie });
const asKey = (p: Person) => ({ secret: p.secret });

const project = (title: string, body: string) =>
  `---\ntype: project\ntitle: ${title}\nstatus: active\n---\n\n# ${title}\n\n${body}\n`;
const decisions = (slug: string, id: string, title: string) =>
  `---\ntype: decision-log\nproject: ${slug}\n---\n\n## ${id} · ${title}\n- date: 2026-10-01\n- status: active\n- rationale: Because zebra.\n`;

/** A owns a space with two projects (alpha, beta) and a project-less topic. B is a stranger. */
async function world() {
  const a = await person();
  const b = await person();
  const files: [string, string][] = [
    ['projects/alpha.md', project('Alpha', 'zebra alpha plan. See [[projects/beta]].')],
    ['projects/beta.md', project('Beta', 'zebra beta secret. Builds on [[projects/alpha]].')],
    ['decisions/alpha.md', decisions('alpha', 'DEC-0001', 'Alpha zebra choice')],
    ['decisions/beta.md', decisions('beta', 'DEC-0002', 'Beta zebra choice')],
    ['topics/general.md', '# General\n\nzebra general notes.\n'],
  ];
  for (const [path, content] of files) {
    const r = await rest(asKey(a), 'PUT', '/note', { path, content, base_version: null });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  }
  return { a, b };
}

async function share(
  owner: Person,
  to: Person,
  role: 'viewer' | 'editor' | 'admin',
  opts: { project?: string; accept?: boolean; agents?: boolean } = {},
): Promise<Grant> {
  const created = await rest(asWeb(owner), 'POST', '/grants', {
    space_id: owner.space,
    email: to.user.email,
    role,
    ...(opts.project ? { project: opts.project } : {}),
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  if (opts.accept ?? true) {
    const accepted = await rest(asWeb(to), 'POST', `/grants/${created.body.id}/accept`, {
      include_in_agent_context: opts.agents ?? true,
    });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
  }
  return created.body as Grant;
}

const paths = (hits: { path: string }[]) => hits.map((h) => h.path).sort();

/** Everything B can reach of A's space, through keys (MCP + REST) and the web session. */
async function reach(a: Person, b: Person) {
  const search = await mcp(b.secret, 'brain_search', { query: 'zebra', limit: 50 });
  const webSearch = await rest(asWeb(b), 'GET', '/search?q=zebra&limit=50');
  const read = await mcp(b.secret, 'brain_read', { path: 'projects/alpha.md', space_id: a.space });
  const ctx = await mcp(b.secret, 'brain_context', { project: 'alpha' });
  const list = await rest(asKey(b), 'GET', '/notes?limit=200');
  return {
    search: search.isError ? [] : (search.data.hits as any[]),
    webSearch: (webSearch.body?.hits ?? []) as any[],
    read,
    ctx,
    list: (list.body.items as any[]).filter((n) => n.source?.space === a.space),
  };
}

describe('without an accepted grant', () => {
  it('B cannot read, search, get context from or write to A’s space', async () => {
    const { a, b } = await world();
    const r = await reach(a, b);
    expect(r.search).toEqual([]);
    expect(r.webSearch).toEqual([]);
    expect(r.list).toEqual([]);
    expect(r.read.isError).toBe(true);
    expect(r.read.text).toMatch(/do not have access/);
    expect(r.ctx.data.project).toBeNull();
    expect(r.ctx.data.decisions).toEqual([]);

    // Guessing the path without a space id finds nothing either.
    expect((await mcp(b.secret, 'brain_read', { path: 'projects/alpha.md' })).isError).toBe(true);
    expect(
      (await mcp(b.secret, 'brain_context', { project: 'alpha', space_id: a.space })).isError,
    ).toBe(true);
    expect(
      (await rest(asWeb(b), 'GET', `/note?path=projects/alpha.md&space_id=${a.space}`)).status,
    ).toBe(403);
    expect((await rest(asWeb(b), 'GET', `/graph?space_id=${a.space}`)).status).toBe(403);
    expect((await rest(asWeb(b), 'GET', `/dashboard?space_id=${a.space}`)).status).toBe(403);
    expect((await rest(asKey(b), 'GET', `/notes?space_id=${a.space}`)).status).toBe(403);

    const w = await mcp(b.secret, 'brain_write', {
      path: 'topics/pwned.md',
      content: '# Pwned',
      space_id: a.space,
    });
    expect(w.isError).toBe(true);
    const put = await rest(asWeb(b), 'PUT', '/note', {
      path: 'topics/pwned.md',
      content: '# Pwned',
      base_version: null,
      space_id: a.space,
    });
    expect(put.status).toBe(403);
    const imp = await rest(asKey(b), 'POST', '/import', {
      files: [{ path: 'topics/pwned.md', content: '# Pwned' }],
      space_id: a.space,
    });
    expect(imp.status).toBe(403);
    const save = await mcp(b.secret, 'brain_save', {
      session_id: 'ses_x',
      summary: 'Sneaky',
      space_id: a.space,
    });
    expect(save.isError).toBe(true);
    const files = await env.DB.prepare('SELECT path FROM notes WHERE space_id = ?')
      .bind(a.space)
      .all<{ path: string }>();
    expect(files.results.map((f) => f.path)).not.toContain('topics/pwned.md');
  });

  it('a pending grant gives nothing until it is accepted', async () => {
    const { a, b } = await world();
    const g = await share(a, b, 'editor', { accept: false });
    expect(g.status).toBe('pending');

    const inbox = await rest(asWeb(b), 'GET', '/invitations');
    expect(inbox.body.items.map((i: Invitation) => i.id)).toEqual([g.id]);
    expect(inbox.body.items[0]).toMatchObject({
      space_id: a.space,
      role: 'editor',
      owner: { email: a.user.email },
    });

    const r = await reach(a, b);
    expect(r.search).toEqual([]);
    expect(r.webSearch).toEqual([]);
    expect(r.read.isError).toBe(true);
    const w = await mcp(b.secret, 'brain_write', {
      path: 'topics/early.md',
      content: '# Early',
      space_id: a.space,
    });
    expect(w.isError).toBe(true);

    // Declined is just as closed, and cannot be accepted afterwards.
    expect((await rest(asWeb(b), 'POST', `/grants/${g.id}/decline`)).status).toBe(200);
    expect((await reach(a, b)).search).toEqual([]);
    const late = await rest(asWeb(b), 'POST', `/grants/${g.id}/accept`, {});
    expect(late.status).toBe(409);
  });
});

describe('with an accepted grant', () => {
  it('a viewer reads with provenance but cannot write', async () => {
    const { a, b } = await world();
    await share(a, b, 'viewer');
    const r = await reach(a, b);
    expect(paths(r.search)).toEqual([
      'decisions/alpha.md',
      'decisions/beta.md',
      'projects/alpha.md',
      'projects/beta.md',
      'topics/general.md',
    ]);
    const source = { space: a.space, space_name: 'Personal', owner: a.user.email };
    expect(r.search.every((h) => h.source?.space === a.space)).toBe(true);
    expect(r.search[0].source).toEqual(source);
    expect(r.read.isError, r.read.text).toBe(false);
    expect(r.read.data.source).toEqual(source);
    expect(r.read._meta.space).toBe(a.space);
    expect(r.ctx.data.project).toMatchObject({ slug: 'alpha', source });
    expect(r.ctx.data.decisions).toEqual([expect.objectContaining({ id: 'DEC-0001', source })]);

    const me = await rest(asWeb(b), 'GET', '/me');
    expect(me.body.spaces).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: a.space, role: 'viewer', source })]),
    );

    const w = await mcp(b.secret, 'brain_write', {
      path: 'topics/viewer.md',
      content: '# Nope',
      space_id: a.space,
    });
    expect(w.isError).toBe(true);
    expect(w.text).toMatch(/viewer/);
    const put = await rest(asWeb(b), 'PUT', '/note', {
      path: 'projects/alpha.md',
      content: '# Overwritten',
      base_version: null,
      space_id: a.space,
    });
    expect(put.status).toBe(403);
    const sess = await mcp(b.secret, 'brain_save', {
      session_id: r.ctx.data.session_id,
      summary: 'Viewer session',
      space_id: a.space,
    });
    expect(sess.isError).toBe(true);
    // A viewer's session started on A's project is logged in B's own space instead.
    const own = await mcp(b.secret, 'brain_save', {
      session_id: r.ctx.data.session_id,
      summary: 'Viewer session',
    });
    expect(own.isError, own.text).toBe(false);
    expect(own._meta.space).toBe(b.space);
    // Viewers can't share onwards.
    const reshare = await rest(asWeb(b), 'POST', '/grants', {
      space_id: a.space,
      email: 'friend@example.com',
      role: 'viewer',
    });
    expect(reshare.status).toBe(403);
  });

  it('an editor writes, and history records who wrote it', async () => {
    const { a, b } = await world();
    await share(a, b, 'editor');
    const w = await mcp(b.secret, 'brain_write', {
      path: 'topics/from-b.md',
      content: '# From B\n\nzebra contribution',
      space_id: a.space,
    });
    expect(w.isError, w.text).toBe(false);
    expect(w._meta.space).toBe(a.space);
    const commit = await env.DB.prepare(
      'SELECT message, author FROM vault_commits WHERE space_id = ? ORDER BY created_at DESC LIMIT 1',
    )
      .bind(a.space)
      .first<{ message: string; author: string }>();
    expect(commit?.message).toContain(`Second-Brain-Actor: user:${b.user.id} key:${b.key.id}`);
    expect(commit?.author).toContain(b.user.email);

    // A sees B's note in their own space (no source: it's theirs).
    const hits = await mcp(a.secret, 'brain_search', { query: 'contribution' });
    expect(hits.data.hits).toEqual([expect.objectContaining({ path: 'topics/from-b.md' })]);
    expect(hits.data.hits[0].source).toBeUndefined();

    // The session ritual on A's project lands in A's space.
    const ctx = await mcp(b.secret, 'brain_context', { project: 'alpha' });
    const saved = await mcp(b.secret, 'brain_save', {
      session_id: ctx.data.session_id,
      summary: 'Pairing on alpha',
      decisions: [{ title: 'Ship alpha', rationale: 'Ready.' }],
    });
    expect(saved.isError, saved.text).toBe(false);
    expect(saved._meta.space).toBe(a.space);
    expect(saved.data.decision_ids).toEqual(['DEC-0003']);
  });

  it('a read-only key cannot write, even for an editor', async () => {
    const { a, b } = await world();
    await share(a, b, 'editor');
    const { secret } = await createKey(env.DB, env.KEY_PEPPER, {
      userId: b.user.id,
      label: 'ro',
      scopes: ['read'],
      project: null,
    });
    expect(
      (await mcp(secret, 'brain_search', { query: 'zebra' })).data.hits.length,
    ).toBeGreaterThan(0);
    const w = await mcp(secret, 'brain_write', {
      path: 'topics/ro.md',
      content: '# RO',
      space_id: a.space,
    });
    expect(w.isError).toBe(true);
    expect(w.text).toMatch(/"write" scope/);
    const put = await rest({ secret }, 'PUT', '/note', {
      path: 'topics/ro.md',
      content: '# RO',
      base_version: null,
      space_id: a.space,
    });
    expect(put.status).toBe(403);
    const ctx = await mcp(secret, 'brain_context', { project: 'alpha' });
    const save = await mcp(secret, 'brain_save', {
      session_id: ctx.data.session_id,
      summary: 'x',
    });
    expect(save.isError).toBe(true);
  });
});

describe('project-level grants', () => {
  it('never leak other projects through search, list, read, context or backlinks', async () => {
    const { a, b } = await world();
    await share(a, b, 'editor', { project: 'alpha' });

    const r = await reach(a, b);
    expect(paths(r.search)).toEqual(['decisions/alpha.md', 'projects/alpha.md']);
    expect(paths(r.webSearch)).toEqual(['decisions/alpha.md', 'projects/alpha.md']);
    expect(paths(r.list)).toEqual(['decisions/alpha.md', 'projects/alpha.md']);
    const listed = await rest(asWeb(b), 'GET', `/notes?space_id=${a.space}&limit=200`);
    expect(paths(listed.body.items)).toEqual(['decisions/alpha.md', 'projects/alpha.md']);

    // Read: the granted project works, its links into beta stay unresolved, backlinks are filtered.
    expect(r.read.isError, r.read.text).toBe(false);
    expect(r.read.data.backlinks).toEqual([]);
    const detail = await rest(asWeb(b), 'GET', `/note?path=projects/alpha.md&space_id=${a.space}`);
    expect(detail.status).toBe(200);
    expect(detail.body.backlinks).toEqual([]);
    expect(detail.body.links).toEqual([{ target: 'projects/beta', path: null }]);
    // A sees the full picture of the same note.
    const full = await rest(asKey(a), 'GET', '/note?path=projects/alpha.md');
    expect(full.body.backlinks).toEqual([{ path: 'projects/beta.md', title: 'Beta' }]);

    for (const path of ['projects/beta.md', 'decisions/beta.md', 'topics/general.md']) {
      const other = await mcp(b.secret, 'brain_read', { path, space_id: a.space });
      expect(other.isError, path).toBe(true);
      expect(
        (await rest(asWeb(b), 'GET', `/note?path=${path}&space_id=${a.space}`)).status,
        path,
      ).toBe(404);
    }

    // Context: alpha only.
    expect(r.ctx.data.project).toMatchObject({ slug: 'alpha' });
    expect(r.ctx.data.decisions.map((d: any) => d.id)).toEqual(['DEC-0001']);
    const beta = await mcp(b.secret, 'brain_context', { project: 'beta', space_id: a.space });
    expect(beta.data.project).toBeNull();
    expect(beta.data.decisions).toEqual([]);
    expect(JSON.stringify(beta.data)).not.toContain('Beta');
    const projects = await mcp(b.secret, 'brain_projects', {});
    expect(
      projects.data.projects
        .filter((x: any) => x.source?.space === a.space)
        .map((x: any) => x.slug),
    ).toEqual(['alpha']);

    // Space-wide views are narrowed too.
    const g = await rest(asWeb(b), 'GET', `/graph?space_id=${a.space}`);
    expect(g.body.nodes.map((n: any) => n.id).sort()).toEqual([
      'decisions/alpha.md',
      'projects/alpha.md',
    ]);
    expect(g.body.edges).toEqual([]);
    const dash = await rest(asWeb(b), 'GET', `/dashboard?space_id=${a.space}`);
    expect(dash.body.stats).toEqual({ notes: 2, topics: 0, decisions: 1, sessions: 0 });
    expect(dash.body.check.broken_links).toEqual([]);

    // Writes: inside alpha only.
    const ok = await mcp(b.secret, 'brain_write', {
      path: 'projects/alpha.md',
      content: project('Alpha', 'zebra alpha plan v2.'),
      space_id: a.space,
    });
    expect(ok.isError, ok.text).toBe(false);
    for (const [path, content] of [
      ['projects/beta.md', project('Beta', 'hijacked')],
      ['topics/general.md', '# General\n\nhijacked'],
      // Moving a beta note into alpha (or the reverse) is caught on both sides of the change.
      ['decisions/beta.md', '---\ntype: decision-log\nproject: alpha\n---\n\nhijacked'],
    ] as const) {
      const denied = await mcp(b.secret, 'brain_write', { path, content, space_id: a.space });
      expect(denied.isError, path).toBe(true);
    }
    const sneaky = await mcp(b.secret, 'brain_write', {
      path: 'topics/alpha-notes.md',
      content: '---\nproject: beta\n---\n\n# Into beta',
      space_id: a.space,
    });
    expect(sneaky.isError).toBe(true);
    const imp = await rest(asWeb(b), 'POST', '/import', {
      files: [{ path: 'projects/alpha.md', content: project('Alpha', 'imported') }],
      space_id: a.space,
    });
    expect(imp.status).toBe(403);
    const unchanged = await rest(asKey(a), 'GET', '/note?path=projects/beta.md');
    expect(unchanged.body.body).toContain('zebra beta secret');
  });

  it('takes the max of the space grant and the project grant', async () => {
    const { a, b } = await world();
    await share(a, b, 'viewer');
    await share(a, b, 'editor', { project: 'alpha' });
    const alpha = await mcp(b.secret, 'brain_write', {
      path: 'projects/alpha.md',
      content: project('Alpha', 'zebra edited by b'),
      space_id: a.space,
    });
    expect(alpha.isError, alpha.text).toBe(false);
    const beta = await mcp(b.secret, 'brain_write', {
      path: 'projects/beta.md',
      content: project('Beta', 'edited by b'),
      space_id: a.space,
    });
    expect(beta.isError).toBe(true);
    // The space grant still shows everything.
    expect(paths((await reach(a, b)).search)).toHaveLength(5);
  });
});

describe('consent and revocation', () => {
  it('revocation is effective on the very next request', async () => {
    const { a, b } = await world();
    const g = await share(a, b, 'editor');
    expect((await reach(a, b)).search.length).toBe(5);

    expect((await rest(asWeb(a), 'DELETE', `/grants/${g.id}`)).status).toBe(204);
    const r = await reach(a, b);
    expect(r.search).toEqual([]);
    expect(r.webSearch).toEqual([]);
    expect(r.read.isError).toBe(true);
    const w = await mcp(b.secret, 'brain_write', {
      path: 'topics/after.md',
      content: '# After',
      space_id: a.space,
    });
    expect(w.isError).toBe(true);
    const listed = await rest(asWeb(a), 'GET', `/grants?space_id=${a.space}`);
    expect(listed.body.items).toEqual([]);
  });

  it('include_in_agent_context=0 hides content from keys but not from the web session', async () => {
    const { a, b } = await world();
    const g = await share(a, b, 'viewer', { agents: false });

    const r = await reach(a, b);
    expect(r.search).toEqual([]);
    expect(r.read.isError).toBe(true);
    expect(r.ctx.data.project).toBeNull();
    expect(r.list).toEqual([]);
    expect(paths(r.webSearch)).toHaveLength(5);
    const web = await rest(asWeb(b), 'GET', `/note?path=projects/alpha.md&space_id=${a.space}`);
    expect(web.status).toBe(200);
    expect(web.body.source.space).toBe(a.space);

    // Only the recipient flips it, and only from a web session.
    expect(
      (await rest(asWeb(a), 'PATCH', `/grants/${g.id}`, { include_in_agent_context: true })).status,
    ).toBe(403);
    expect(
      (await rest(asKey(b), 'PATCH', `/grants/${g.id}`, { include_in_agent_context: true })).status,
    ).toBe(403);
    const on = await rest(asWeb(b), 'PATCH', `/grants/${g.id}`, { include_in_agent_context: true });
    expect(on.status).toBe(200);
    expect((await reach(a, b)).search).toHaveLength(5);
    // brain_context include_shared=false still keeps it out.
    const own = await mcp(b.secret, 'brain_context', { project: 'alpha', include_shared: false });
    expect(own.data.project).toBeNull();
  });

  it('agents cannot share, accept or change roles; admins can, owners always', async () => {
    const { a, b } = await world();
    const c = await person();
    const viaKey = await rest(asKey(a), 'POST', '/grants', {
      space_id: a.space,
      email: c.user.email,
      role: 'viewer',
    });
    expect(viaKey.status).toBe(403);

    await share(a, b, 'admin');
    const byAdmin = await rest(asWeb(b), 'POST', '/grants', {
      space_id: a.space,
      email: c.user.email,
      role: 'viewer',
    });
    expect(byAdmin.status).toBe(201);
    const dup = await rest(asWeb(a), 'POST', '/grants', {
      space_id: a.space,
      email: c.user.email,
      role: 'editor',
    });
    expect(dup.status).toBe(409);
    const accept = await rest(asKey(c), 'POST', `/grants/${byAdmin.body.id}/accept`, {
      include_in_agent_context: true,
    });
    expect(accept.status).toBe(403);
    // Someone else can't accept C's invitation.
    expect((await rest(asWeb(a), 'POST', `/grants/${byAdmin.body.id}/accept`, {})).status).toBe(
      404,
    );

    const promote = await rest(asWeb(b), 'PATCH', `/grants/${byAdmin.body.id}`, { role: 'editor' });
    expect(promote.status).toBe(200);
    expect(promote.body.role).toBe('editor');
    const mine = (await rest(asWeb(a), 'GET', `/grants?space_id=${a.space}`)).body.items as Grant[];
    const bGrant = mine.find((x) => x.email === b.user.email)!;
    expect((await rest(asWeb(b), 'PATCH', `/grants/${bGrant.id}`, { role: 'viewer' })).status).toBe(
      403,
    );
    // A stranger can't see or revoke A's grants.
    expect((await rest(asWeb(c), 'GET', `/grants?space_id=${a.space}`)).status).toBe(403);
    expect((await rest(asWeb(c), 'DELETE', `/grants/${bGrant.id}`)).status).toBe(404);

    const actions = await env.DB.prepare(
      "SELECT action FROM audit_log WHERE space_id = ? AND action LIKE 'grant.%' ORDER BY at, id",
    )
      .bind(a.space)
      .all<{ action: string }>();
    expect(actions.results.map((x) => x.action)).toEqual([
      'grant.create',
      'grant.accept',
      'grant.create',
      'grant.update',
    ]);
  });

  it('a grant to an email without an account waits and attaches on sign-up', async () => {
    const { a } = await world();
    const email = `later-${crypto.randomUUID()}@example.com`;
    const created = await rest(asWeb(a), 'POST', '/grants', {
      space_id: a.space,
      email,
      role: 'viewer',
      project: 'alpha',
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ status: 'pending', grantee_user_id: null, email });

    const user = await upsertUserByEmail(env.DB, email);
    const session = await createSession(env.DB, user.id);
    const later = { cookie: `sb_session=${session.token}` };
    const inbox = await rest(later, 'GET', '/invitations');
    expect(inbox.body.items).toEqual([
      expect.objectContaining({ id: created.body.id, project: 'alpha', status: 'pending' }),
    ]);
    const row = await env.DB.prepare('SELECT grantee_user_id FROM grants WHERE id = ?')
      .bind(created.body.id)
      .first<{ grantee_user_id: string }>();
    expect(row?.grantee_user_id).toBe(user.id);

    // Nothing visible until accepted; then only alpha.
    expect((await rest(later, 'GET', '/search?q=zebra')).body.hits).toEqual([]);
    expect((await rest(later, 'POST', `/grants/${created.body.id}/accept`, {})).status).toBe(200);
    const hits = (await rest(later, 'GET', '/search?q=zebra')).body.hits;
    expect(paths(hits)).toEqual(['decisions/alpha.md', 'projects/alpha.md']);
    const accepted = await rest(later, 'GET', '/invitations?status=accepted');
    expect(accepted.body.items).toEqual([
      expect.objectContaining({ id: created.body.id, include_in_agent_context: false }),
    ]);
  });
});
