# Second Brain

> One persistent, shared memory for you, your team, and every AI assistant you work with.

Second Brain is a knowledge and memory platform. People and AI assistants (Claude, Cursor, Copilot, ChatGPT, custom agents) read from and write to the same store of Markdown notes: projects, decisions, topics and session logs. You open a new chat on any machine, with any assistant, and it already knows what you were doing, what you decided and why, and what comes next.

It begins as a personal daily-driver and is designed from the start to be sold to businesses as an **internal knowledge tool**, with multi-tenant isolation, sharing, SSO and audit trails.

> **Status:** Phase 0, planning. This repository holds the product plan, architecture and engineering standards. Code starts in Phase 1 (see [Roadmap](docs/05-delivery/roadmap.md)).

---

## The problem

| Pain | Today | With Second Brain |
|---|---|---|
| AI assistants forget everything between sessions | You re-explain context every chat | `brain_context` loads current state, recent decisions and last sessions in one call |
| Several assistants and machines | Each one keeps partial memory, or none | One store, reachable by every MCP-capable client |
| Decisions get lost | "Why did we pick X?" is buried in chat history | Append-only decision log with rationale and supersession |
| Team knowledge is scattered | Docs, Slack and people's heads | Shared spaces with roles, so agents work from the team's real context |
| Lock-in | Memory is trapped inside one vendor's app | Plain Markdown in Git you own, editable in Obsidian or any editor |

## What we are building

1. **Memory server (MCP + REST)**: a TypeScript service on Cloudflare Workers that exposes memory tools to any MCP client.
2. **Vault**: Markdown notes with YAML frontmatter and `[[wikilinks]]`, stored in Git (the source of truth). Each note is a project, decision, topic, session or a free note.
3. **Search index**: SQLite (Cloudflare D1) full-text search, plus an optional semantic layer (embeddings and vector search, merged with reciprocal rank fusion). The index is a cache that can be rebuilt from Git at any time.
4. **Session ritual**: `context`, then work, then `save`, then a periodic `check`. This is where most of the value comes from.
5. **Web app**: browse, search, edit, graph view, manage keys, spaces, sharing and audit logs.
6. **CLI (`brain`)**: sign a machine in once, store keys in the OS keychain, auto-configure installed assistants, and run activity-logging hooks.
7. **Teams and business tier**: orgs, spaces, roles, invitations with consent, SSO, audit log and data export.

## Core features (v1 must-haves)

- MCP tools: `brain_context`, `brain_save`, `brain_search`, `brain_read`, `brain_write`, `brain_check`, `brain_projects`
- Atomic multi-file saves (one commit per save)
- Heading-aware chunking and full-text search with permission filters applied inside the query
- Token-budgeted context responses, with superseded decisions hidden
- Per-machine, per-assistant API keys with scopes (read-only, project-limited), plus OAuth 2.1 for MCP clients
- Secret redaction on the client and again on the server; all memory treated as untrusted data
- Web UI for reading, editing, searching and key management
- Personal spaces, plus sharing of projects or spaces as viewer or editor

The full prioritised list is in [Requirements](docs/01-product/requirements.md).

## Architecture at a glance

```
 AI clients (Claude, Cursor, ...)   Web app   brain CLI   Git push (webhook)
            │ MCP / HTTPS              │ HTTPS     │           │
            ▼                          ▼           ▼           ▼
 ┌──────────────────── Cloudflare Worker: API gateway ────────────────────┐
 │ authN (keys / OAuth / session) → authZ (RBAC) → rate limit → router    │
 │   MCP tools   REST API   Webhooks   Admin                              │
 │        └──── domain services (Notes, Search, Session, Sharing) ────┘   │
 └───────┬───────────┬───────────┬───────────┬───────────┬────────────────┘
         ▼           ▼           ▼           ▼           ▼
    Git provider    D1 (SQLite   R2 (archives,  KV (hot     Queues + Cron
    (source of      + FTS5       backups,       lookups,    (index sync, embed,
     truth)         index, meta) exports)       rate limit) archive, rebuild)
                                                            │
                                               Vectorize + Workers AI (embeddings)
```

Read more: [High-level design](docs/02-architecture/hld.md) · [Low-level design](docs/02-architecture/lld.md)

## Documentation map

| Area | Document |
|---|---|
| Product | [Vision & personas](docs/01-product/vision.md) · [Requirements](docs/01-product/requirements.md) |
| Architecture | [HLD](docs/02-architecture/hld.md) · [LLD](docs/02-architecture/lld.md) · [ADRs](docs/adr/) |
| Security | [Security & encryption](docs/03-security/security.md) |
| Collaboration | [Sharing & multi-tenancy](docs/04-collaboration/sharing-and-tenancy.md) |
| Delivery | [Roadmap](docs/05-delivery/roadmap.md) · [Engineering standards](docs/05-delivery/engineering-standards.md) |
| Reference | [Notes on the reference design (BrainMCP)](docs/reference/brainmcp-reference.md) |
| Runbooks | [Local development](docs/runbooks/local-dev.md) · [Keep a vault in GitHub (Obsidian, VS Code)](docs/runbooks/github-vault.md) |

## Planned tech stack

| Layer | Choice | Why (see ADRs) |
|---|---|---|
| Language | TypeScript (strict) everywhere | One language across server, web, CLI and shared domain code |
| Runtime | Cloudflare Workers | Serverless, global, millisecond cold starts, low cost ([ADR-0002](docs/adr/0002-cloudflare-workers-runtime.md)) |
| API | Hono + `@modelcontextprotocol/sdk` (Streamable HTTP) | Small, fast, Workers-native |
| Source of truth | Git (GitHub App), behind a `VaultStore` interface | You own your data; history for free ([ADR-0001](docs/adr/0001-git-as-source-of-truth.md)) |
| Index / metadata | Cloudflare D1 (SQLite + FTS5) | Built-in BM25 ranking, rebuildable ([ADR-0003](docs/adr/0003-sqlite-fts-index-as-cache.md)) |
| Semantic search | Vectorize + Workers AI embeddings, RRF fusion | Optional layer; degrades to keyword search ([ADR-0004](docs/adr/0004-hybrid-search-rrf.md)) |
| Blobs | R2 | Archived session logs, backups, exports |
| Async | Queues + Cron Triggers | Index sync, embedding, nightly rebuild |
| Web | React + Vite + TanStack Router/Query, served as Workers static assets | Same platform; no separate host |
| Validation | Zod schemas shared across packages | One contract for MCP, REST and UI |
| Monorepo | pnpm workspaces + Turborepo | Fast, cached builds |
| Testing | Vitest (+ `@cloudflare/vitest-pool-workers`), Playwright | Tests run against the real Workers runtime |
| CI/CD | GitHub Actions → Wrangler deploy (staging → prod) | |

## Repository layout (target)

```
second-brain/
├── apps/
│   ├── server/          # Cloudflare Worker: MCP + REST + webhooks + cron consumers
│   └── web/             # React dashboard
├── packages/
│   ├── core/            # Pure domain logic: parser, chunker, ranking, budgeter, redactor
│   ├── schema/          # Zod schemas and shared types (MCP tool I/O, REST DTOs)
│   ├── db/              # D1 migrations + typed repository layer (tenant-scoped)
│   ├── vault/           # VaultStore interface + GitHub implementation
│   ├── cli/             # `brain` CLI: login, keychain, client config, hooks
│   └── config/          # Shared tsconfig / eslint / prettier
├── docs/                # This plan: product, HLD/LLD, security, ADRs
├── .github/             # CI workflows, templates, CODEOWNERS
└── README.md
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security issues: see [SECURITY.md](SECURITY.md).

## License

Second Brain is open source under the [GNU AGPL-3.0](LICENSE). You can use, modify and self-host it freely. If you run a modified version as a network service, you must share your changes under the same licence.
