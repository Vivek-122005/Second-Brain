# High-Level Design (HLD)

## 1. Context (C4 level 1)

```
            ┌──────────────┐        ┌──────────────┐       ┌──────────────┐
            │ Human (web / │        │ AI assistant │       │ Admin (org)  │
            │  Obsidian)   │        │ (MCP client) │       │              │
            └──────┬───────┘        └──────┬───────┘       └──────┬───────┘
                   │ HTTPS / git push      │ MCP over HTTPS        │ HTTPS
                   ▼                       ▼                       ▼
            ┌──────────────────────────────────────────────────────────────┐
            │                        SECOND BRAIN                          │
            └───────┬───────────────────────┬──────────────────────┬───────┘
                    ▼                       ▼                      ▼
             Git provider            Identity providers       Email provider
             (GitHub App)            (GitHub/Google/OIDC)     (invites, magic links)
```

## 2. Containers (C4 level 2)

| Container | Tech | Responsibility |
|---|---|---|
| **API Worker** (`apps/server`) | Cloudflare Worker, Hono, MCP SDK | Single entrypoint: `/mcp` (Streamable HTTP), `/api/v1/*` REST, `/webhooks/*`, `/oauth/*`. AuthN, AuthZ, rate limiting, domain services |
| **Web app** (`apps/web`) | React + Vite, static assets on Workers | Human UI; talks only to `/api/v1` |
| **CLI** (`packages/cli`) | Node, distributed via npm | `brain login`, keychain, client config, hook runner, activity spooler |
| **D1** | SQLite + FTS5 | Metadata (tenants, users, keys, ACLs, audit) + search index (chunks, FTS, links). Index tables rebuildable |
| **Git vault** | GitHub repo per space (via GitHub App installation) | Source of truth for note content |
| **R2** | Object storage | Archived activity/session logs, nightly backups, exports, attachments |
| **KV** | Key-value | Hot caches: key→principal lookups (short TTL), rate-limit counters, feature flags |
| **Queues** | Cloudflare Queues | `index-sync`, `embed`, `archive`, `audit-fanout`; at-least-once, idempotent consumers |
| **Cron Triggers** | Scheduled Worker | Nightly full rebuild, archival, check reports, backup |
| **Vectorize + Workers AI** | Vector DB + embedding model | Optional semantic layer (`@cf/baai/bge-base-en-v1.5`, 768-d, swappable) |
| **Durable Objects** | Per-space DO | Serialises writes per space (commit queue, version counter), avoiding Git ref races |

## 3. Logical architecture (layers)

```
apps/server
 ├── transport/      MCP handler, REST routes, webhook receivers, cron/queue handlers
 ├── middleware/     request-id, authn, authz, rate-limit, redaction, error mapping
 ├── services/       NotesService, SearchService, SessionService, SharingService,
 │                   KeyService, AuditService, IndexService
 └── adapters/       D1Repo, GitVaultStore, R2Blob, KVCache, VectorIndex, Embedder, Mailer
packages/core        pure functions: frontmatter parse, chunker, wikilink parser,
                     RRF fusion, token budgeter, secret redactor, decision supersession
```

Rule: `core` has **no I/O**. Services depend on adapter *interfaces*, so tests swap in fakes and self-hosting can swap Cloudflare for Node/Postgres/S3.

## 4. Key flows

### 4.1 Read: `brain_context`

```
client ─MCP→ Worker: authn(key) → principal{user, key scopes}
                     authz: resolve readable spaces (own + accepted shares) ∩ key scope
                     SessionService.context(project, budget)
                       ├─ D1: project note row, decisions (not superseded), last K sessions,
                       │      active projects        (single round-trip batch)
                       ├─ core.budget(): trim sessions → decisions → project tail
                       └─ D1: insert session(open) → session_id
             ←──── compact JSON, wrapped in <untrusted-memory> envelope
```

Reads come from D1 only, never from Git. That keeps them fast and avoids GitHub API rate limits.

### 4.2 Write: `brain_save`

```
client ─MCP→ Worker → authz(write on space/project)
           → redactor.scrub(payload)            # server-side second pass
           → SpaceWriter DO (per space, serialised)
               ├─ build file set: session log, decisions append, topic updates, project fm
               ├─ GitVaultStore.commit(files, baseSha)   # one atomic commit (Git Trees API)
               ├─ on success: IndexService.applyChanges(files, newSha)  # immediate D1 upsert
               └─ AuditService.record(...)
           ← {commit_sha, session_id, paths[]}
```

Indexing right after commit gives read-your-writes. The webhook that follows for the same SHA is a no-op, because the index records `indexed_sha` per note.

### 4.3 External edit: Git push from Obsidian

```
GitHub ─webhook→ /webhooks/github (HMAC verified) → enqueue index-sync{space, before, after}
Queue consumer → compare commits → changed paths → fetch blobs → parse/chunk → upsert D1
              → enqueue embed{note_ids} (if semantic enabled)
```

### 4.4 Nightly full rebuild (safety net)

1. `generation = now()`.
2. Walk the Git tree at HEAD and upsert every note and chunk with `generation`.
3. **Only after success**, delete rows where `generation < current`.
4. On failure, the old rows stay in place, so the index is never empty.

## 5. Deployment topology

| Env | Purpose | Data |
|---|---|---|
| `local` | `wrangler dev` + Miniflare, local D1/R2/KV | Fixtures |
| `preview` | Per-PR Worker deploy | Ephemeral D1 |
| `staging` | Mirrors prod config | Synthetic + dogfood |
| `production` | Live | Region-pinned D1 for Business tenants (jurisdiction) |

Releases are trunk-based: merge to `main` deploys to staging; a tagged release promotes to production through a gradual rollout. D1 migrations are forward-only and backward-compatible (expand → migrate → contract).

## 6. Scalability and tenancy strategy

- **Phase 1–2:** one D1 database, with every row tenant-keyed (`space_id`).
- **Phase 3+ (Business):** a **D1 database per org** (D1 is designed for many small databases). A routing table in a control-plane D1 maps `org_id → db binding / region`. This gives hard isolation, per-tenant backup and restore, and data residency.
- Writes are serialised per space through a Durable Object, so commit throughput scales with the number of spaces.

## 7. Failure modes

| Failure | Behaviour |
|---|---|
| Git provider down / rate-limited | Reads unaffected. Writes are durably queued in the SpaceWriter DO storage and committed on recovery; the client gets `202 accepted, pending_commit` |
| D1 index corrupted / drifted | Nightly rebuild, or a manual `reindex` admin action; Git stays untouched |
| Vectorize / AI unavailable | Search degrades to FTS only and the response says `semantic: "unavailable"` |
| Queue consumer crash | At-least-once redelivery; consumers are idempotent (keyed by `space_id + sha + path`) |
| Webhook missed | Nightly rebuild repairs the index; `sync_state.last_sha` is compared on each request (cheap) |

## 8. Cross-cutting concerns

- **Observability:** structured JSON logs (`request_id`, `tenant`, `tool`, `latency_ms`, never content), Workers Analytics Engine for metrics, Sentry for errors, and an OpenTelemetry-compatible trace header.
- **Rate limiting:** per key and per tenant token buckets (KV/DO), with stricter limits on writes.
- **Configuration:** typed env bindings validated at boot with Zod; secrets live in Wrangler secrets, never in the repo.
- **API versioning:** REST is `/api/v1`. MCP tool schemas are versioned with additive changes only, and breaking changes get new tool names.
