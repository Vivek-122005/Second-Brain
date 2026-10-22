import { describe, expect, it } from 'vitest';
import { evaluate, ndcgAt, parseCases } from '../../../evals/ndcg';
import evalSet from '../../../evals/search.jsonl?raw';
import { callWith, FakeAi, FakeVectorize, semanticEnv } from './fakes';
import { newUserWithKey } from './helpers';

/**
 * Search relevance eval (ADR-0004): nDCG@5 of keyword vs hybrid over `evals/search.jsonl` and the
 * fixture vault in `evals/vault`. In CI the semantic leg uses the deterministic fake embedder, so
 * this guards the pipeline (indexing, fusion, permissions) and keyword ranking against regressions;
 * it says nothing about the real model's quality. Run it alone with
 * `pnpm --filter @second-brain/server eval:search`.
 */
const vault = import.meta.glob('../../../evals/vault/**/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

describe('ndcg', () => {
  it('scores ideal, partial and empty rankings', () => {
    expect(ndcgAt(5, ['a', 'b'], { a: 3, b: 1 })).toBe(1);
    expect(ndcgAt(5, ['b', 'a'], { a: 3, b: 1 })).toBeLessThan(1);
    expect(ndcgAt(5, ['x', 'y'], { a: 3 })).toBe(0);
    expect(ndcgAt(1, ['x', 'a'], { a: 3 })).toBe(0);
  });
});

describe('search relevance eval (evals/search.jsonl)', () => {
  it('hybrid is at least as good as keyword, and better on paraphrases', async () => {
    const cases = parseCases(evalSet);
    expect(cases.length).toBeGreaterThanOrEqual(12);
    const files = Object.entries(vault).map(([p, content]) => ({
      path: p.replace(/^.*evals\/vault\//, ''),
      content,
    }));
    expect(files.length).toBeGreaterThanOrEqual(10);

    const e = semanticEnv(new FakeAi(), new FakeVectorize());
    const u = await newUserWithKey();
    const headers = { authorization: `Bearer ${u.secret}`, 'content-type': 'application/json' };
    const me = (await (await callWith(e, '/api/v1/me', { headers })).json()) as {
      default_space_id: string;
    };
    await callWith(e, `/api/v1/spaces/${me.default_space_id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ semantic_enabled: true }),
    });
    const imported = await callWith(e, '/api/v1/import', {
      method: 'POST',
      headers,
      body: JSON.stringify({ files }),
    });
    expect(imported.status).toBe(200);

    const run = (mode: 'keyword' | 'hybrid') => async (q: string) => {
      const r = await callWith(
        e,
        `/api/v1/search?q=${encodeURIComponent(q)}&limit=5&mode=${mode}`,
        {
          headers,
        },
      );
      const body = (await r.json()) as { hits: { path: string }[]; semantic: string };
      if (mode === 'hybrid') expect(body.semantic).toBe('used');
      return body.hits.map((h) => h.path);
    };
    const keyword = await evaluate(cases, run('keyword'));
    const hybrid = await evaluate(cases, run('hybrid'));

    const para = (r: typeof keyword) => {
      const xs = r.perCase.filter((c) => c.id.startsWith('para-'));
      return xs.reduce((s, c) => s + c.ndcg, 0) / xs.length;
    };
    console.warn(
      `nDCG@5 keyword=${keyword.mean.toFixed(3)} hybrid=${hybrid.mean.toFixed(3)} ` +
        `(paraphrases: keyword=${para(keyword).toFixed(3)} hybrid=${para(hybrid).toFixed(3)})`,
    );

    // Exact-term queries must stay strong in both modes (keyword ranking is not regressed).
    for (const c of keyword.perCase.filter((x) => x.id.startsWith('exact-'))) {
      expect(c.ndcg, c.id).toBeGreaterThan(0.8);
    }
    expect(hybrid.mean).toBeGreaterThanOrEqual(keyword.mean);
    expect(para(hybrid)).toBeGreaterThan(para(keyword));
  });
});
