# ADR-0002: Cloudflare Workers as the runtime platform

- Status: accepted
- Date: 2026-10-21

## Context
We need a low-ops, low-cost, globally fast runtime with a database, blob store, queues, cron, vectors and embeddings, usable by one person today and many tenants later.

## Decision
Use Cloudflare Workers with D1, R2, KV, Queues, Cron Triggers, Durable Objects, Vectorize and Workers AI. Domain logic stays runtime-agnostic in `packages/core`, and adapters isolate the platform.

## Consequences
- Millisecond cold starts, near-zero idle cost, one vendor bill, and per-tenant D1 databases are feasible.
- We have to respect platform limits (CPU time, D1 batch and row sizes, subrequest counts), so we test against them in CI with the Workers vitest pool.
- There is some vendor lock-in. Mitigated by adapter interfaces and an eventual Node/Postgres/S3 self-host target.

## Alternatives considered
Vercel + Postgres (Neon) + pgvector (strong, but more moving parts and cost at idle). A single VPS (cheap, but we'd own patching, scaling and backups).
