# ADR-0004: Optional semantic search merged with reciprocal rank fusion

- Status: accepted
- Date: 2026-10-21

## Context
Keyword search misses paraphrases ("auth" vs "login"). Semantic search catches them but returns weak matches when nothing relevant exists, costs money to embed, and its scores are on a different scale from BM25.

## Decision
Ship keyword search first. Add an **optional** semantic layer behind the `Embedder` interface (Workers AI `bge-base-en-v1.5` by default, OD-4):

- One embedding per note (later: per chunk), stored in Vectorize with tenant/space metadata for filtering.
- Keyword and vector queries run in parallel and merge with **reciprocal rank fusion** (`score = Σ 1/(k + rank)`, `k = 60`), so no score normalisation is needed.
- Re-embed only notes whose **content hash** changed; cap embeddings per run so a large first import spreads over several nights.
- Drop vector hits below a **minimum similarity floor**.
- If Vectorize/AI is unavailable, fall back to FTS only and report `semantic: "unavailable"`.

## Consequences
- ✅ Better recall without hurting precision; graceful degradation.
- ✅ Embedding cost stays near zero after the first import.
- ⚠️ Needs an eval set (`evals/search.jsonl`, nDCG@5) to prove it beats keyword-only before it is on by default.
- ⚠️ Permission filtering must also apply to vector results before fusion.

## Alternatives considered
- **Semantic only:** poor on exact identifiers, file names and error strings.
- **Weighted score blending:** requires fragile score normalisation across scales.
