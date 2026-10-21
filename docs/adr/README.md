# Architecture Decision Records

Each significant or hard-to-reverse decision is recorded as `NNNN-title.md` (Context → Decision → Consequences). Accepted ADRs are immutable; to change one, write a new ADR that supersedes it.

| ADR | Title | Status |
|---|---|---|
| [0001](0001-git-as-source-of-truth.md) | Git is the source of truth for note content | Accepted |
| [0002](0002-cloudflare-workers-runtime.md) | Cloudflare Workers as the runtime | Accepted |
| [0003](0003-sqlite-fts-index-as-cache.md) | SQLite (D1) + FTS5 index as a rebuildable cache | Accepted |
| [0004](0004-hybrid-search-rrf.md) | Optional semantic search merged with reciprocal rank fusion | Accepted |
| [0005](0005-mcp-streamable-http-and-scoped-keys.md) | MCP over Streamable HTTP with per-machine scoped keys and OAuth 2.1 | Accepted |
| [0006](0006-tenant-isolation-strategy.md) | Tenant isolation: row-level now, database-per-org for Business | Accepted |

Template: copy [0000-template.md](0000-template.md).
