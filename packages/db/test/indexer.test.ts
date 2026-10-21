import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import {
  applyChanges,
  brokenLinks,
  getBacklinks,
  getNote,
  graph,
  listNotes,
  listProjects,
  maxDecisionNumber,
  noteStats,
  rebuildIndex,
  recentDecisions,
  recentSessionNotes,
  searchNotes,
  type VaultFile,
} from '../src';

const db = env.DB;

const VAULT: VaultFile[] = [
  {
    path: 'projects/billing.md',
    content: `---
type: project
title: Billing refactor
status: active
goal: Replace legacy invoicing with Stripe Billing
next: [Migrate webhooks, Backfill invoices]
---

# Billing refactor

Moving invoicing to Stripe. See [[topics/webhooks]] and [[topics/missing-topic]].
`,
  },
  {
    path: 'projects/garden.md',
    content:
      '---\ntype: project\ntitle: Garden app\nstatus: paused\n---\n\nA small side project.\n',
  },
  {
    path: 'topics/webhooks.md',
    content: `---
type: topic
title: Webhooks
aliases: [hooks]
---

# Webhooks

## Retries

Stripe retries webhooks with exponential backoff for three days. Handlers must be idempotent.

## Signatures

Verify the signature header before trusting the payload.
`,
  },
  {
    path: 'decisions/billing.md',
    content: `---
type: decision-log
project: billing
---

## DEC-0001 · Use Redis for job dedupe
- date: 2026-09-01
- status: superseded
- superseded_by: DEC-0002
- rationale: Fast.

## DEC-0002 · Use Postgres advisory locks for job dedupe
- date: 2026-10-01
- status: active
- supersedes: DEC-0001
- rationale: Already on Postgres; Redis adds an ops dependency.
`,
  },
  {
    path: 'sessions/2026/10/2026-10-20-ses_a.md',
    content: `---
type: session
id: ses_a
project: "[[projects/billing]]"
summary: Wired up webhook retries
next: [Backfill invoices]
---

# Session

Talked about webhooks and retries a lot. Webhooks webhooks webhooks.
`,
  },
  { path: '.obsidian/workspace.md', content: 'ignored' },
];

async function seed(spaceId = 'spc_a') {
  return rebuildIndex(db, spaceId, VAULT, 'sha1');
}

describe('rebuildIndex', () => {
  it('indexes markdown files and skips hidden folders', async () => {
    const r = await seed();
    expect(r).toMatchObject({ indexed: 5 });
    const note = await getNote(db, ['spc_a'], 'projects/billing.md');
    expect(note).toMatchObject({
      type: 'project',
      title: 'Billing refactor',
      project_slug: 'billing',
      indexed_sha: 'sha1',
    });
    expect(await getNote(db, ['spc_a'], '.obsidian/workspace.md')).toBeNull();
  });

  it('removes notes that disappeared, only after writing the new generation', async () => {
    const first = await seed();
    const r = await rebuildIndex(
      db,
      'spc_a',
      VAULT.filter((f) => f.path !== 'projects/garden.md'),
      'sha2',
    );
    expect(r).toMatchObject({ removed: 1, generation: first.generation + 1 });
    expect(await getNote(db, ['spc_a'], 'projects/garden.md')).toBeNull();
    expect(await getNote(db, ['spc_a'], 'projects/billing.md')).toMatchObject({
      indexed_sha: 'sha2',
    });
  });
});

describe('searchNotes', () => {
  it('finds notes by keyword with the best chunk per note and excludes sessions by default', async () => {
    await seed();
    const hits = await searchNotes(db, {
      spaceIds: ['spc_a'],
      query: 'webhooks retries',
      limit: 8,
    });
    expect(hits.map((h) => h.path)).toEqual(['topics/webhooks.md']);
    expect(hits[0]?.heading).toBe('Webhooks > Retries');
    expect(hits[0]?.snippet).toContain('**');

    const withSessions = await searchNotes(db, {
      spaceIds: ['spc_a'],
      query: 'webhooks',
      limit: 8,
      includeSessions: true,
    });
    expect(withSessions.map((h) => h.path)).toContain('sessions/2026/10/2026-10-20-ses_a.md');
  });

  it('treats FTS syntax in queries as plain words', async () => {
    await seed();
    await expect(
      searchNotes(db, { spaceIds: ['spc_a'], query: 'title:x OR (NEAR "unbalanced', limit: 5 }),
    ).resolves.toEqual([]);
  });

  it('never returns rows from spaces the caller cannot read', async () => {
    await seed('spc_a');
    await rebuildIndex(
      db,
      'spc_b',
      [{ path: 'topics/secret.md', content: '# Secret\n\nwebhooks plan' }],
      's',
    );
    const hits = await searchNotes(db, {
      spaceIds: ['spc_a'],
      query: 'webhooks',
      limit: 50,
      includeSessions: true,
    });
    expect(hits.some((h) => h.path === 'topics/secret.md')).toBe(false);
    expect(await searchNotes(db, { spaceIds: [], query: 'webhooks', limit: 5 })).toEqual([]);
    expect(await getNote(db, ['spc_a'], 'topics/secret.md')).toBeNull();
  });

  it('filters by type and project', async () => {
    await seed();
    const topics = await searchNotes(db, {
      spaceIds: ['spc_a'],
      query: 'stripe',
      types: ['topic'],
      limit: 5,
    });
    expect(topics.every((h) => h.type === 'topic')).toBe(true);
    const billing = await searchNotes(db, {
      spaceIds: ['spc_a'],
      query: 'stripe',
      project: 'billing',
      limit: 5,
    });
    expect(billing.map((h) => h.path)).toEqual(['projects/billing.md']);
  });
});

describe('links', () => {
  it('records backlinks and broken links, and repairs them when the target appears', async () => {
    await seed();
    expect(await getBacklinks(db, 'spc_a', 'topics/webhooks.md')).toEqual([
      { path: 'projects/billing.md', title: 'Billing refactor' },
    ]);
    expect(await brokenLinks(db, 'spc_a')).toEqual([
      { from: 'projects/billing.md', target: 'topics/missing-topic' },
    ]);

    await applyChanges(
      db,
      'spc_a',
      { upserts: [{ path: 'topics/missing-topic.md', content: '# Now here' }], deletes: [] },
      'sha3',
    );
    expect(await brokenLinks(db, 'spc_a')).toEqual([]);

    await applyChanges(db, 'spc_a', { upserts: [], deletes: ['topics/webhooks.md'] }, 'sha4');
    expect(await brokenLinks(db, 'spc_a')).toEqual([
      { from: 'projects/billing.md', target: 'topics/webhooks' },
    ]);
    expect(await searchNotes(db, { spaceIds: ['spc_a'], query: 'idempotent', limit: 5 })).toEqual(
      [],
    );
  });

  it('builds a graph without session notes', async () => {
    await seed();
    const g = await graph(db, ['spc_a']);
    expect(g.nodes.map((n) => n.id).sort()).toEqual([
      'decisions/billing.md',
      'projects/billing.md',
      'projects/garden.md',
      'topics/webhooks.md',
    ]);
    expect(g.edges).toEqual([{ source: 'projects/billing.md', target: 'topics/webhooks.md' }]);
  });
});

describe('applyChanges', () => {
  it('replaces a note atomically, keeping updated_at when content is unchanged', async () => {
    await seed();
    const before = await getNote(db, ['spc_a'], 'topics/webhooks.md');
    await applyChanges(db, 'spc_a', { upserts: [VAULT[2]!], deletes: [] }, 'sha5');
    const same = await getNote(db, ['spc_a'], 'topics/webhooks.md');
    expect(same?.updated_at).toBe(before?.updated_at);

    await applyChanges(
      db,
      'spc_a',
      {
        upserts: [
          { path: 'topics/webhooks.md', content: '# Webhooks\n\nRewritten entirely about queues.' },
        ],
        deletes: [],
      },
      'sha6',
    );
    expect(await searchNotes(db, { spaceIds: ['spc_a'], query: 'idempotent', limit: 5 })).toEqual(
      [],
    );
    expect(
      (await searchNotes(db, { spaceIds: ['spc_a'], query: 'queues', limit: 5 }))[0]?.path,
    ).toBe('topics/webhooks.md');
  });
});

describe('projects, decisions, sessions, stats', () => {
  it('lists projects with status filter', async () => {
    await seed();
    const all = await listProjects(db, ['spc_a']);
    expect(all.map((p) => p.slug).sort()).toEqual(['billing', 'garden']);
    const active = await listProjects(db, ['spc_a'], 'active');
    expect(active).toEqual([
      expect.objectContaining({ slug: 'billing', status: 'active', next: 'Migrate webhooks' }),
    ]);
  });

  it('hides superseded decisions unless asked', async () => {
    await seed();
    const ds = await recentDecisions(db, ['spc_a'], { project: 'billing', limit: 10 });
    expect(ds.map((d) => d.id)).toEqual(['DEC-0002']);
    const all = await recentDecisions(db, ['spc_a'], { limit: 10, includeSuperseded: true });
    expect(all.map((d) => d.id)).toEqual(['DEC-0002', 'DEC-0001']);
    expect(await maxDecisionNumber(db, 'spc_a')).toBe(2);
    expect(await maxDecisionNumber(db, 'spc_empty')).toBe(0);
  });

  it('returns recent session notes and counts', async () => {
    await seed();
    const s = await recentSessionNotes(db, ['spc_a'], { project: 'billing', limit: 3 });
    expect(s.map((x) => x.path)).toEqual(['sessions/2026/10/2026-10-20-ses_a.md']);
    expect(await noteStats(db, ['spc_a'])).toEqual({
      notes: 5,
      topics: 1,
      decisions: 1,
      sessions: 1,
    });
  });

  it('paginates notes with a stable cursor', async () => {
    await seed();
    const p1 = await listNotes(db, { spaceIds: ['spc_a'], limit: 2 });
    expect(p1.items).toHaveLength(2);
    expect(p1.next).not.toBeNull();
    const p2 = await listNotes(db, { spaceIds: ['spc_a'], limit: 2, cursor: p1.next ?? undefined });
    const p3 = await listNotes(db, { spaceIds: ['spc_a'], limit: 2, cursor: p2.next ?? undefined });
    const all = [...p1.items, ...p2.items, ...p3.items].map((i) => i.path);
    expect(new Set(all).size).toBe(5);
    expect(p3.next).toBeNull();
  });
});

describe('scale', () => {
  it('indexes hundreds of notes within D1 statement limits', async () => {
    const files: VaultFile[] = Array.from({ length: 300 }, (_, i) => ({
      path: `topics/t${i}.md`,
      content: `# Topic ${i}\n\n${'## Section\n\nSome text about subject ' + i + '.\n\n'.repeat(3)}See [[topics/t${(i + 1) % 300}]].`,
    }));
    const r = await rebuildIndex(db, 'spc_scale', files, 'big');
    expect(r.indexed).toBe(300);
    expect(await brokenLinks(db, 'spc_scale')).toEqual([]);
    const hits = await searchNotes(db, { spaceIds: ['spc_scale'], query: 'subject 42', limit: 3 });
    expect(hits[0]?.path).toBe('topics/t42.md');
  });
});
