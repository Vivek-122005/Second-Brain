# ADR-0004: Optional hybrid search via Reciprocal Rank Fusion

- Status: accepted
- Date: 2026-10-21

## Context
Keyword search misses paraphrases, while vector-only search misses exact identifiers (error codes, names).

## Decision
Keep FTS as the always-on baseline. When semantic search is enabled for a space, embed chunks (Workers AI, behind an `Embedder` interface) into Vectorize with `space_id`/`project_id` metadata, and fuse the two rankings with RRF (k=60), applying a minimum similarity threshold. Re-embed only when a note's content hash changes, and cap the work per run.

## Consequences
- Better recall without losing precision. If the vector side fails, search degrades gracefully to FTS.
- Extra cost and an eventual-consistency window for embeddings (seconds to minutes).
