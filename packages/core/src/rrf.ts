export interface FusedResult {
  id: string;
  score: number;
  /** 1-based rank in each input list (undefined when absent from that list). */
  ranks: (number | undefined)[];
}

/**
 * Reciprocal rank fusion (ADR-0004): score(d) = Σ 1 / (k + rank_i(d)).
 * Works on ranks only, so lists with incomparable scores (BM25 vs cosine) merge cleanly.
 */
export function reciprocalRankFusion(lists: string[][], k = 60): FusedResult[] {
  const byId = new Map<string, FusedResult>();
  lists.forEach((list, li) => {
    const seen = new Set<string>();
    list.forEach((id, i) => {
      if (seen.has(id)) return;
      seen.add(id);
      const entry = byId.get(id) ?? {
        id,
        score: 0,
        ranks: new Array<number | undefined>(lists.length).fill(undefined),
      };
      entry.score += 1 / (k + i + 1);
      entry.ranks[li] = i + 1;
      byId.set(id, entry);
    });
  });
  return [...byId.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}
