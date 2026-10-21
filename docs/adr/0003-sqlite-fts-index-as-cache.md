# ADR-0003: SQLite (D1) FTS5 index as a rebuildable cache

- Status: accepted
- Date: 2026-10-21

## Context
Reads (context, search) must be fast and must not depend on Git API availability.

## Decision
Index notes, chunks, links, decisions and sessions in D1 with FTS5/BM25. The index is updated immediately after each commit, incrementally via push webhooks, and fully by a nightly rebuild that writes the new generation before deleting stale rows.

## Consequences
- Fast reads with permission filters in SQL.
- Index drift is possible and is repaired nightly. `indexed_sha` per note makes reprocessing idempotent.
- Identity, ACL, key and audit tables in the same D1 are **not** cache. They are backed up nightly to R2.
