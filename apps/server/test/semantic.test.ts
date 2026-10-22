import { applyChanges, noteId, rebuildIndex } from '@second-brain/db';
import type { SearchHit } from '@second-brain/schema';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { workersAiEmbedder } from '../src/search/embedder';
import {
  bestVectorHitPerNote,
  fuseHits,
  MIN_SIMILARITY,
  type VectorHit,
} from '../src/search/fusion';
import { withExecutionContext } from '../src/lib/defer';
import {
  embedCatchUp,
  embedSpace,
  scheduleSpaceEmbedding,
  type Semantic,
} from '../src/search/semantic';
import { vectorFilter, vectorizeIndex } from '../src/search/vectors';
import { callWith, FakeAi, FakeVectorize, semanticEnv } from './fakes';
import { env, mcp, newUserWithKey } from './helpers';

const hit = (path: string, score = 1): SearchHit => ({
  path,
  title: path,
  type: 'topic',
  heading: '',
  snippet: '',
  score,
});
const vhit = (path: string, score: number, heading = ''): VectorHit => ({
  path,
  title: path,
  type: 'topic',
  heading,
  body: `body of ${path}`,
  score,
});

function sem(ai: FakeAi, vec: FakeVectorize, model?: string): Semantic {
  return {
    embedder: workersAiEmbedder(ai as unknown as Ai, model),
    vectors: vectorizeIndex(vec as unknown as Vectorize),
  };
}

async function setup(
  opts: { semantic?: boolean; ai?: FakeAi | null; vec?: FakeVectorize | null } = {},
) {
  const ai = opts.ai === undefined ? new FakeAi() : opts.ai;
  const vec = opts.vec === undefined ? new FakeVectorize() : opts.vec;
  const e = semanticEnv(ai, vec);
  const u = await newUserWithKey();
  const auth = { authorization: `Bearer ${u.secret}`, 'content-type': 'application/json' };
  const me = (await (await callWith(e, '/api/v1/me', { headers: auth })).json()) as {
    default_space_id: string;
  };
  const spaceId = me.default_space_id;
  const api = (path: string, init: RequestInit = {}) =>
    callWith(e, path, { ...init, headers: { ...auth, ...(init.headers ?? {}) } });
  if (opts.semantic) {
    const r = await api(`/api/v1/spaces/${spaceId}`, {
      method: 'PATCH',
      body: JSON.stringify({ semantic_enabled: true }),
    });
    expect(r.status).toBe(200);
  }
  const put = async (path: string, content: string) => {
    const cur = await api(`/api/v1/note?path=${encodeURIComponent(path)}`);
    const base = cur.status === 200 ? ((await cur.json()) as { version: string }).version : null;
    const r = await api('/api/v1/note', {
      method: 'PUT',
      body: JSON.stringify({ path, content, base_version: base }),
    });
    expect(r.status).toBe(200);
  };
  const search = async (q: string, extra = '') =>
    (await (await api(`/api/v1/search?q=${encodeURIComponent(q)}${extra}`)).json()) as {
      hits: SearchHit[];
      mode: string;
      semantic: string;
    };
  // Tests that pass null bindings never touch the fakes; the casts keep the common case terse.
  return { ai: ai as FakeAi, vec: vec as FakeVectorize, e, u, spaceId, api, put, search };
}

const AUTH_NOTE = `---\ntype: topic\ntitle: Authentication\n---\n\n# Authentication\n\n## Passkeys\n\nUsers authenticate with passkeys; the password fallback was removed.\n`;
const DEPLOY_NOTE = `---\ntype: topic\ntitle: Releases\n---\n\n# Releases\n\nEvery merge goes to staging; a tag promotes to production.\n`;

describe('fusion (pure)', () => {
  it('orders by reciprocal rank fusion with k=60', () => {
    const fused = fuseHits(
      [hit('a.md'), hit('b.md'), hit('c.md')],
      [vhit('c.md', 0.9), vhit('d.md', 0.8)],
      { limit: 10 },
    );
    // c: 1/63 + 1/61; a: 1/61; b: 1/62 and d: 1/62 tie, broken by id.
    expect(fused.map((h) => h.path)).toEqual(['c.md', 'a.md', 'b.md', 'd.md']);
    expect(fused[0]?.score).toBeCloseTo(1 / 63 + 1 / 61, 5);
    expect(fused[1]?.score).toBeCloseTo(1 / 61, 5);
  });

  it('drops vector hits below the similarity floor', () => {
    expect(MIN_SIMILARITY).toBe(0.35);
    const fused = fuseHits([], [vhit('weak.md', 0.34), vhit('ok.md', 0.35)], { limit: 10 });
    expect(fused.map((h) => h.path)).toEqual(['ok.md']);
    expect(fuseHits([hit('kw.md')], [vhit('weak.md', 0.2)], { limit: 10 })).toHaveLength(1);
  });

  it('keeps the best chunk per note and the keyword snippet when both lists agree', () => {
    const best = bestVectorHitPerNote([
      vhit('n.md', 0.5, 'low'),
      vhit('n.md', 0.9, 'high'),
      vhit('m.md', 0.6),
    ]);
    expect(best.map((h) => [h.path, h.heading])).toEqual([
      ['n.md', 'high'],
      ['m.md', ''],
    ]);
    const kw = { ...hit('n.md'), snippet: '**kw** snippet' };
    const fused = fuseHits([kw], [vhit('n.md', 0.9)], { limit: 5 });
    expect(fused).toHaveLength(1);
    expect(fused[0]?.snippet).toBe('**kw** snippet');
  });

  it('respects the limit', () => {
    const fused = fuseHits([hit('a.md'), hit('b.md')], [vhit('c.md', 0.9), vhit('d.md', 0.9)], {
      limit: 3,
    });
    expect(fused).toHaveLength(3);
  });
});

describe('embedder and vector index adapters', () => {
  it('batches Workers AI calls and validates the response shape', async () => {
    const ai = new FakeAi();
    const emb = workersAiEmbedder(ai as unknown as Ai, '@cf/test/model');
    const out = await emb.embed(Array.from({ length: 120 }, (_, i) => `text ${i}`));
    expect(out).toHaveLength(120);
    expect(ai.calls).toBe(3);
    expect(ai.models).toEqual(['@cf/test/model', '@cf/test/model', '@cf/test/model']);
    expect(emb.model).toBe('@cf/test/model');

    const broken = workersAiEmbedder({ run: async () => ({ data: [[1]] }) } as unknown as Ai);
    await expect(broken.embed(['a', 'b'])).rejects.toThrow(/wrong shape/);
  });

  it('builds metadata filters for spaces, project, types and sessions', () => {
    expect(vectorFilter({ topK: 5, spaceIds: ['s1', 's2'], excludeSessions: true })).toEqual({
      space_id: { $in: ['s1', 's2'] },
      type: { $ne: 'session' },
    });
    expect(
      vectorFilter({
        topK: 5,
        spaceIds: ['s1'],
        project: 'billing',
        types: ['topic'],
        excludeSessions: true,
      }),
    ).toEqual({ space_id: { $in: ['s1'] }, project: { $eq: 'billing' }, type: { $in: ['topic'] } });
    expect(() => vectorFilter({ topK: 5, spaceIds: [], excludeSessions: false })).toThrow();
  });
});

describe('embedding pipeline', () => {
  it('backfills when enabled, then re-embeds only notes whose content hash changed', async () => {
    const s = await setup();
    await s.put('topics/auth.md', AUTH_NOTE);
    await s.put('topics/releases.md', DEPLOY_NOTE);
    // Semantic search is off: nothing was embedded.
    expect(s.ai.calls).toBe(0);
    expect(s.vec.vectors.size).toBe(0);

    const r = await s.api(`/api/v1/spaces/${s.spaceId}`, {
      method: 'PATCH',
      body: JSON.stringify({ semantic_enabled: true }),
    });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { semantic_enabled: boolean }).semantic_enabled).toBe(true);
    const authId = await noteId(s.spaceId, 'topics/auth.md');
    const relId = await noteId(s.spaceId, 'topics/releases.md');
    expect(s.vec.idsFor(authId).length).toBeGreaterThan(0);
    expect(s.vec.idsFor(relId).length).toBeGreaterThan(0);
    const meta = await env.DB.prepare(
      'SELECT note_id, model, content_hash FROM embeddings_meta WHERE space_id = ?',
    )
      .bind(s.spaceId)
      .all<{ note_id: string; model: string }>();
    expect(meta.results).toHaveLength(2);
    expect(meta.results[0]?.model).toBe('@cf/baai/bge-base-en-v1.5');
    const metadata = s.vec.vectors.get(`${authId}:0`)?.metadata;
    expect(metadata).toMatchObject({ space_id: s.spaceId, note_id: authId, type: 'topic' });

    // Change one note: only its chunks are embedded again.
    s.ai.reset();
    await s.put('topics/auth.md', AUTH_NOTE.replace('removed', 'retired last spring'));
    expect(s.ai.texts.length).toBeGreaterThan(0);
    expect(s.ai.texts.every((t) => t.includes('Authentication'))).toBe(true);
    expect(s.ai.texts.some((t) => t.includes('Releases'))).toBe(false);

    // Same content again: the hash matches, nothing is embedded.
    s.ai.reset();
    await s.put('topics/auth.md', AUTH_NOTE.replace('removed', 'retired last spring'));
    expect(s.ai.calls).toBe(0);

    // The nightly job has nothing left to do either.
    const run = await embedCatchUp(s.e, { maxChunks: 1000 });
    expect(run.status).toBe('ran');
    const mine = await embedSpace(env.DB, sem(s.ai, s.vec), s.spaceId, { maxChunks: 1000 });
    expect(mine.notes).toBe(0);
  });

  it('deletes vectors for chunks that disappear and for removed or rebuilt-away notes', async () => {
    const s = await setup({ semantic: true });
    const long = `# Big\n\n## One\n\nalpha\n\n## Two\n\nbeta\n\n## Three\n\ngamma\n`;
    await s.put('topics/big.md', long);
    await s.put('topics/gone.md', '# Gone\n\nsoon removed\n');
    const bigId = await noteId(s.spaceId, 'topics/big.md');
    const goneId = await noteId(s.spaceId, 'topics/gone.md');
    const before = s.vec.idsFor(bigId).length;
    expect(before).toBeGreaterThanOrEqual(3);

    await s.put('topics/big.md', '# Big\n\nnow short\n');
    expect(s.vec.idsFor(bigId)).toEqual([`${bigId}:0`]);

    // Removed from the index (e.g. by a sync or a rebuild): the next run purges its vectors.
    await applyChanges(env.DB, s.spaceId, { upserts: [], deletes: ['topics/gone.md'] }, null);
    expect(s.vec.idsFor(goneId).length).toBe(1);
    await embedSpace(env.DB, sem(s.ai, s.vec), s.spaceId, { maxChunks: 10 });
    expect(s.vec.idsFor(goneId)).toEqual([]);
    const metaGone = await env.DB.prepare('SELECT 1 FROM embeddings_meta WHERE note_id = ?')
      .bind(goneId)
      .first();
    expect(metaGone).toBeNull();

    // A full rebuild that drops a note: the nightly catch-up purges its vectors.
    await rebuildIndex(
      env.DB,
      s.spaceId,
      [{ path: 'topics/other.md', content: '# Other\n\nstill here\n' }],
      null,
    );
    await embedCatchUp(s.e, { maxChunks: 50 });
    expect(s.vec.idsFor(bigId)).toEqual([]);
    expect(s.vec.idsFor(await noteId(s.spaceId, 'topics/other.md')).length).toBe(1);
  });

  it('embeds after a GitHub sync only for semantic-enabled spaces', async () => {
    const runDeferred = async (fn: () => void) => {
      const ctx = createExecutionContext();
      withExecutionContext(ctx, fn);
      await waitOnExecutionContext(ctx);
    };
    const on = await setup({ semantic: true });
    const off = await setup();
    for (const s of [on, off]) {
      await applyChanges(
        env.DB,
        s.spaceId,
        { upserts: [{ path: 'topics/synced.md', content: AUTH_NOTE }], deletes: [] },
        'sha1',
      );
      await runDeferred(() => scheduleSpaceEmbedding(s.e, s.spaceId, ['topics/synced.md']));
    }
    expect(on.vec.idsFor(await noteId(on.spaceId, 'topics/synced.md')).length).toBeGreaterThan(0);
    expect(off.vec.vectors.size).toBe(0);

    // After a full rebuild (paths = null) the whole space is scanned for changed hashes.
    await applyChanges(
      env.DB,
      on.spaceId,
      { upserts: [{ path: 'topics/later.md', content: DEPLOY_NOTE }], deletes: [] },
      'sha2',
    );
    await runDeferred(() => scheduleSpaceEmbedding(on.e, on.spaceId, null));
    expect(on.vec.idsFor(await noteId(on.spaceId, 'topics/later.md')).length).toBeGreaterThan(0);
  });

  it('re-embeds everything when the model changes', async () => {
    const s = await setup({ semantic: true });
    await s.put('topics/auth.md', AUTH_NOTE);
    s.ai.reset();
    const r = await embedSpace(env.DB, sem(s.ai, s.vec, '@cf/other/model'), s.spaceId, {
      maxChunks: 100,
    });
    expect(r.notes).toBe(1);
    expect(s.ai.models.every((m) => m === '@cf/other/model')).toBe(true);
    const row = await env.DB.prepare('SELECT model FROM embeddings_meta WHERE note_id = ?')
      .bind(await noteId(s.spaceId, 'topics/auth.md'))
      .first<{ model: string }>();
    expect(row?.model).toBe('@cf/other/model');
  });

  it('caps the nightly catch-up at 200 chunks per run so a big import spreads over nights', async () => {
    const ai = new FakeAi();
    const vec = new FakeVectorize();
    const u = await newUserWithKey();
    const space = await env.DB.prepare('SELECT id FROM spaces WHERE owner_user_id = ?')
      .bind(u.user.id)
      .first<{ id: string }>();
    const spaceId = space!.id;
    // 50 notes × 5 sections = 250 chunks, indexed directly (as an import or sync would).
    const files = Array.from({ length: 50 }, (_, i) => ({
      path: `topics/n${i}.md`,
      content: `# Note ${i}\n\n${[1, 2, 3, 4, 5].map((j) => `## Part ${j}\n\ntext ${i}-${j}\n`).join('\n')}`,
    }));
    await applyChanges(env.DB, spaceId, { upserts: files, deletes: [] }, null);
    await env.DB.prepare('UPDATE spaces SET semantic_enabled = 1 WHERE id = ?').bind(spaceId).run();
    const s = sem(ai, vec);

    // Only this space matters for the cap assertions: disable the others created by other tests.
    await env.DB.prepare('UPDATE spaces SET semantic_enabled = 0 WHERE id != ?')
      .bind(spaceId)
      .run();

    const first = await embedCatchUp(semanticEnv(ai, vec), { semantic: s });
    expect(first.chunks).toBeLessThanOrEqual(200);
    expect(first.chunks).toBeGreaterThan(150);
    expect(first.remaining).toBe(true);
    expect(vec.vectors.size).toBe(first.chunks);

    const second = await embedCatchUp(semanticEnv(ai, vec), { semantic: s });
    expect(first.chunks + second.chunks).toBe(250);
    expect(second.remaining).toBe(false);
    const third = await embedCatchUp(semanticEnv(ai, vec), { semantic: s });
    expect(third.chunks).toBe(0);

    // The cap is configurable per deployment.
    await env.DB.prepare('DELETE FROM embeddings_meta WHERE space_id = ?').bind(spaceId).run();
    const small = await embedCatchUp(semanticEnv(ai, vec, { SEMANTIC_CRON_CHUNK_CAP: '12' }));
    expect(small.chunks).toBeLessThanOrEqual(12);
    expect(small.chunks).toBeGreaterThan(0);

    // Without bindings the job does nothing.
    expect((await embedCatchUp(semanticEnv(null, null))).status).toBe('unavailable');
  });
});

describe('hybrid search', () => {
  it('finds paraphrases through vectors and reports the mode that ran', async () => {
    const s = await setup({ semantic: true });
    await s.put('topics/auth.md', AUTH_NOTE);
    await s.put('topics/releases.md', DEPLOY_NOTE);

    // "login" never appears in the note: keyword finds nothing, hybrid finds the auth note.
    const kw = await s.search('login', '&mode=keyword');
    expect(kw).toMatchObject({ hits: [], mode: 'keyword', semantic: 'disabled' });
    const hy = await s.search('login');
    expect(hy.mode).toBe('hybrid');
    expect(hy.semantic).toBe('used');
    expect(hy.hits[0]?.path).toBe('topics/auth.md');
    expect(hy.hits.map((h) => h.path)).not.toContain('topics/releases.md');

    // Both legs agree on an exact term: still one hit per note.
    const both = await s.search('staging');
    expect(both.hits.filter((h) => h.path === 'topics/releases.md')).toHaveLength(1);
    expect(both.hits[0]?.path).toBe('topics/releases.md');

    // The vector query was filtered to the caller's spaces and excluded sessions.
    expect(s.vec.filters.at(-1)).toEqual({
      space_id: { $in: [s.spaceId] },
      type: { $ne: 'session' },
    });

    // MCP brain_search uses the same service.
    const viaMcp = await mcp(s.u.secret, 'brain_search', { query: 'login' });
    // The default test env has no AI binding, so MCP degrades to keyword.
    expect(viaMcp.data).toMatchObject({ mode: 'keyword', semantic: 'unavailable' });
  });

  it('defaults to keyword with semantic "disabled" when the space has it off', async () => {
    const s = await setup();
    await s.put('topics/auth.md', AUTH_NOTE);
    const r = await s.search('passkeys');
    expect(r.mode).toBe('keyword');
    expect(r.semantic).toBe('disabled');
    expect(r.hits[0]?.path).toBe('topics/auth.md');
    expect(s.vec.filters).toHaveLength(0);
    // Asking for hybrid does not change that.
    expect((await s.search('passkeys', '&mode=hybrid')).semantic).toBe('disabled');
  });

  it('never leaks another space through vectors, even if the index ignores filters', async () => {
    const vec = new FakeVectorize({ ignoreFilters: true });
    const a = await setup({ semantic: true, vec });
    const b = await setup({ semantic: true, vec, ai: a.ai });
    await b.put('topics/secret-auth.md', AUTH_NOTE.replace('Authentication', 'Secret auth'));
    await a.put('topics/mine.md', '# Mine\n\nnothing about that\n');
    expect(vec.vectors.size).toBeGreaterThan(1);

    const r = await a.search('login password');
    expect(r.semantic).toBe('used');
    expect(r.hits.map((h) => h.path)).not.toContain('topics/secret-auth.md');
    // B sees its own note.
    expect((await b.search('login password')).hits[0]?.path).toBe('topics/secret-auth.md');
  });

  it('applies project scope and type filters to vector hits', async () => {
    const s = await setup({ semantic: true });
    await s.put(
      'projects/billing.md',
      '---\ntype: project\ntitle: Billing\n---\n\n# Billing\n\nLogin for invoices uses passkeys.\n',
    );
    await s.put('topics/auth.md', AUTH_NOTE);
    const scoped = await s.search('login', '&project=billing');
    expect(scoped.semantic).toBe('used');
    expect(scoped.hits.map((h) => h.path)).toEqual(['projects/billing.md']);
    expect(s.vec.filters.at(-1)).toMatchObject({ project: { $eq: 'billing' } });

    const typed = await s.search('login', '&types=topic');
    expect(typed.hits.map((h) => h.path)).toEqual(['topics/auth.md']);
  });

  it('degrades to keyword when bindings are missing or throwing', async () => {
    for (const [ai, vec] of [
      [null, null],
      [new FakeAi(true), new FakeVectorize()],
      [new FakeAi(), new FakeVectorize({ fail: true })],
    ] as const) {
      const s = await setup({ semantic: true, ai, vec });
      // Writes still succeed: embedding failures never reach the caller.
      await s.put('topics/auth.md', AUTH_NOTE);
      const r = await s.search('passkeys');
      expect(r).toMatchObject({ mode: 'keyword', semantic: 'unavailable' });
      expect(r.hits[0]?.path).toBe('topics/auth.md');
    }
  });
});

describe('PATCH /api/v1/spaces/:id', () => {
  it('lets only the owner change semantic_enabled, and purges vectors when switched off', async () => {
    const s = await setup({ semantic: true });
    await s.put('topics/auth.md', AUTH_NOTE);
    expect(s.vec.vectors.size).toBeGreaterThan(0);

    const other = await setup();
    const forbidden = await other.api(`/api/v1/spaces/${s.spaceId}`, {
      method: 'PATCH',
      body: JSON.stringify({ semantic_enabled: false }),
    });
    expect(forbidden.status).toBe(404);

    const bad = await s.api(`/api/v1/spaces/${s.spaceId}`, {
      method: 'PATCH',
      body: JSON.stringify({ semantic_enabled: 'no' }),
    });
    expect(bad.status).toBe(400);

    const readOnly = await newUserWithKey({ scopes: ['read'] });
    const ro = await callWith(s.e, `/api/v1/spaces/${s.spaceId}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${readOnly.secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ semantic_enabled: true }),
    });
    expect(ro.status).toBe(403);

    const off = await s.api(`/api/v1/spaces/${s.spaceId}`, {
      method: 'PATCH',
      body: JSON.stringify({ semantic_enabled: false }),
    });
    expect(off.status).toBe(200);
    expect(s.vec.vectors.size).toBe(0);
    const meta = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM embeddings_meta WHERE space_id = ?',
    )
      .bind(s.spaceId)
      .first<{ n: number }>();
    expect(meta?.n).toBe(0);
    expect((await s.search('passkeys')).semantic).toBe('disabled');
  });

  it('rejects project-limited keys', async () => {
    const u = await newUserWithKey({ project: 'billing' });
    const me = (await (
      await callWith(env, '/api/v1/me', { headers: { authorization: `Bearer ${u.secret}` } })
    ).json()) as { default_space_id: string };
    const r = await callWith(env, `/api/v1/spaces/${me.default_space_id}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${u.secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ semantic_enabled: true }),
    });
    expect(r.status).toBe(403);
  });
});
