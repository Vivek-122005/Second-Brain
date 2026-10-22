/**
 * Search relevance scoring for `evals/search.jsonl` (engineering standards: tracked nDCG@5).
 * Pure, so it runs in workerd tests and anywhere else.
 */

export interface EvalCase {
  id: string;
  query: string;
  /** Graded relevance per vault path: 3 = the answer, 1 = related. Unlisted paths are 0. */
  relevant: Record<string, number>;
}

export function parseCases(jsonl: string): EvalCase[] {
  return jsonl
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as EvalCase);
}

const gain = (rel: number) => 2 ** rel - 1;
const discount = (i: number) => Math.log2(i + 2);

/** nDCG@k with exponential gain. 1 = ideal order, 0 = nothing relevant in the top k. */
export function ndcgAt(k: number, ranked: string[], relevant: Record<string, number>): number {
  const dcg = ranked.slice(0, k).reduce((s, p, i) => s + gain(relevant[p] ?? 0) / discount(i), 0);
  const ideal = Object.values(relevant)
    .sort((a, b) => b - a)
    .slice(0, k)
    .reduce((s, r, i) => s + gain(r) / discount(i), 0);
  return ideal === 0 ? 0 : dcg / ideal;
}

export interface EvalReport {
  mean: number;
  perCase: { id: string; ndcg: number }[];
}

export async function evaluate(
  cases: EvalCase[],
  search: (query: string) => Promise<string[]>,
  k = 5,
): Promise<EvalReport> {
  const perCase: EvalReport['perCase'] = [];
  for (const c of cases)
    perCase.push({ id: c.id, ndcg: ndcgAt(k, await search(c.query), c.relevant) });
  const mean = perCase.reduce((s, x) => s + x.ndcg, 0) / Math.max(perCase.length, 1);
  return { mean, perCase };
}
