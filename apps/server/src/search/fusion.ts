import { reciprocalRankFusion } from '@second-brain/core';
import type { SearchHit } from '@second-brain/schema';

/** RRF constant (ADR-0004). */
export const RRF_K = 60;
/** Vector hits below this cosine similarity are dropped before fusion (LLD §4.2). */
export const MIN_SIMILARITY = 0.35;

/** A search hit with the space it came from (needed for `source` and per-space dedupe). */
export type ScopedHit = SearchHit & { space_id: string };

/** A vector match already resolved (and permission-checked) against D1. */
export interface VectorHit {
  space_id: string;
  path: string;
  title: string;
  type: string;
  heading: string;
  body: string;
  /** Cosine similarity. */
  score: number;
}

const SNIPPET_CHARS = 200;

/** Notes are identified by space + path: the same path can exist in two spaces. */
const keyOf = (h: { space_id: string; path: string }) => `${h.space_id}\n${h.path}`;

export function snippetOf(body: string): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  return flat.length > SNIPPET_CHARS ? `${flat.slice(0, SNIPPET_CHARS).trimEnd()}…` : flat;
}

/** Applies the similarity floor and keeps the best chunk per note, best first. */
export function bestVectorHitPerNote(
  hits: VectorHit[],
  minSimilarity = MIN_SIMILARITY,
): VectorHit[] {
  const best = new Map<string, VectorHit>();
  for (const h of [...hits].sort((a, b) => b.score - a.score)) {
    if (h.score < minSimilarity) continue;
    if (!best.has(keyOf(h))) best.set(keyOf(h), h);
  }
  return [...best.values()];
}

/**
 * Fuses keyword hits (already one per note, best first) with vector hits by reciprocal rank
 * fusion. Ranks only, so BM25 and cosine never need to share a scale. A note found by both keeps
 * the keyword snippet (it highlights the matched terms); the hit score becomes the RRF score.
 */
export function fuseHits(
  keyword: ScopedHit[],
  vector: VectorHit[],
  opts: { limit: number; k?: number; minSimilarity?: number },
): ScopedHit[] {
  const vectors = bestVectorHitPerNote(vector, opts.minSimilarity ?? MIN_SIMILARITY);
  const byKey = new Map<string, ScopedHit>();
  for (const v of vectors) {
    byKey.set(keyOf(v), {
      space_id: v.space_id,
      path: v.path,
      title: v.title,
      type: v.type,
      heading: v.heading,
      snippet: snippetOf(v.body),
      score: 0,
    });
  }
  for (const h of keyword) byKey.set(keyOf(h), h);

  const fused = reciprocalRankFusion([keyword.map(keyOf), vectors.map(keyOf)], opts.k ?? RRF_K);
  const out: ScopedHit[] = [];
  for (const f of fused.slice(0, opts.limit)) {
    const hit = byKey.get(f.id);
    if (hit) out.push({ ...hit, score: Math.round(f.score * 1e6) / 1e6 });
  }
  return out;
}
