# ADR-0008: v1 runtime choices: managed vault, optimistic concurrency, no queues yet

- Status: accepted
- Date: 2026-10-21
- Amends: ADR-0001 (adds a managed vault backend), HLD §2 (Queues, Durable Objects deferred)

## Context
We want a live, usable product quickly on the Cloudflare free plan, without giving up the HLD's guarantees: atomic saves, no lost updates, and a rebuildable index.

## Decision
1. **Two `VaultStore` backends from day one.**
   - `managed`: note files and commits are stored in D1 (`vault_files`, `vault_commits`), giving every space versioned history with no setup. This is the default for new spaces.
   - `github`: a GitHub repository via a fine-grained token per space (GitHub App later), for users who want Obsidian and Git ownership.
   Both implement the same commit semantics (one atomic commit per save, base-version check). A managed space can be exported to Git at any time.
2. **Optimistic concurrency instead of Durable Objects.** Each save carries the space's head version. Managed: the D1 batch only applies if `head = expected`. GitHub: fast-forward-only ref update. Both retry up to three times by re-applying section patches. Durable Objects become an optimisation only if contention shows up.
3. **No Queues in v1.** Webhook re-indexing runs in `ctx.waitUntil` after the 200 response, and a nightly Cron rebuild is the safety net. Embedding catch-up runs on Cron with a per-run cap. Queues come in once a tenant needs higher throughput.
4. **One Worker** serves the API, MCP, OAuth and the web app's static assets, which means one deploy, one domain and no CORS.

## Consequences
- Works on the free plan and is usable without GitHub.
- Under heavy concurrent writes to one space, some saves retry. That's acceptable for personal and team scale.
- ADR-0001's "Git is the source of truth" now reads "the vault (Git or managed history) is the source of truth; the index is a cache".
