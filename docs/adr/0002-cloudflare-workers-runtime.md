# ADR-0002: Cloudflare Workers as the runtime

- Status: accepted
- Date: 2026-10-21

## Context
The service is called at the start and end of every AI session, from many machines and regions. It must be cheap for a single person (daily driver), cost little to operate, start instantly, and scale to many tenants without ops work.

## Decision
Run the API (MCP + REST + webhooks + queue/cron consumers) as a Cloudflare Worker using Hono and the MCP TypeScript SDK (Streamable HTTP). Use the platform's native services: D1 (index/metadata), R2 (blobs), KV (hot lookups), Queues + Cron (async work), Durable Objects (per-space write serialisation), Vectorize + Workers AI (embeddings).

## Consequences
- ✅ Millisecond cold starts, global edge, near-zero cost at personal scale, no servers to patch.
- ✅ One platform for compute, storage and the web app's static assets.
- ⚠️ Platform limits matter (CPU time, D1 statement/batch/row size, subrequest counts): we test against them early in the Workers Vitest pool.
- ⚠️ Vendor coupling: services depend only on adapter interfaces (`VaultStore`, `Embedder`, repos) so a Node/Postgres/S3 self-host build stays possible.

## Alternatives considered
- **Vercel / Node serverless + managed Postgres:** good DX, but more vendors to stitch together for queues, KV, vectors and per-tenant DBs.
- **Containers on Fly/Render:** always-on cost and more ops for a personal tool.
