# ADR-0003: SQLite (D1) + FTS5 index as a rebuildable cache

- Status: accepted
- Date: 2026-10-21

## Context
Agents need fast search and reads. Git cannot serve them (latency, rate limits). The index must never become a second source of truth that drifts from Git.

## Decision
Keep a D1 (SQLite) index holding full note text, heading-aware chunks, an FTS5 table (BM25), links and metadata. It doubles as the read cache: **all reads come from the index**.

- **Write path:** commit to Git, then immediately upsert the touched notes (read-your-writes). Each note records `indexed_sha` so the following webhook is a no-op.
- **Sync:** push webhook → ack fast → queue → re-index only changed paths.
- **Safety net:** a nightly full rebuild writes every row with a new `generation`, then deletes rows with an older generation **only after success**. The index is never emptied first.
- **Query rules:** user terms are quoted (sanitised), session logs are excluded by default, results are over-fetched and deduplicated to the best chunk per note, and permission filters are applied **inside the SQL query, before `LIMIT`**.

## Consequences
- ✅ Fast, cheap reads; a broken index is fixed by rebuilding.
- ✅ SQLite FTS5 gives good keyword ranking with no extra service.
- ⚠️ D1 limits (batch size, statement size, LIKE/pattern length) shape the indexer: batch inserts are chunked and tested at the limits.
- ⚠️ Don't cache `brain_context` responses: they would serve stale decisions right after a save. Cache at the index layer only.

## Alternatives considered
- **Search directly in Git / GitHub code search:** slow, rate-limited, poor ranking.
- **External search service (Typesense, Algolia):** another vendor and another copy to keep in sync, for no gain at our scale.
