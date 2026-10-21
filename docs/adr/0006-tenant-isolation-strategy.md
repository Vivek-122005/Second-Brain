# ADR-0006: Tenant isolation: row-level now, database-per-org for Business

- Status: accepted
- Date: 2026-10-21

## Context
The product must serve one person cheaply and also pass enterprise security reviews.

## Decision
Phases 1–4: one D1 database. Every tenant-owned row carries `space_id` (and `org_id`), and all access goes through a repository layer that requires a `Principal` and injects filters. Phase 5: a database per org, routed via a control-plane table that also selects the region (jurisdiction).

## Consequences
- Simple start, with a clear migration path. A CI tenant-isolation test suite is mandatory from Phase 1.
- Per-org DBs complicate cross-org sharing. Cross-org grants are resolved via the control plane and are read-only federation (Phase 5 design).
