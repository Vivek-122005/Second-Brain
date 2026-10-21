# Requirements

Priority uses MoSCoW: **M** = must (v1), **S** = should (v1.x), **C** = could (later), **W** = won't (for now).
IDs are stable; reference them in issues and PRs (e.g. `FR-SES-02`).

## 1. Functional requirements

### 1.1 Vault and notes (`FR-VLT`)

| ID | Requirement | P |
|---|---|---|
| FR-VLT-01 | Notes are Markdown files with YAML frontmatter; `type` ∈ {`project`, `decision-log`, `topic`, `session`, `note`} | M |
| FR-VLT-02 | Folder convention: `projects/`, `topics/`, `sessions/YYYY/MM/`, `decisions/`, `inbox/` | M |
| FR-VLT-03 | `[[wikilinks]]` (with `|alias` and `#heading`) are parsed into a link graph; backlinks are queryable | M |
| FR-VLT-04 | Git repository is the source of truth; every write is a commit with a structured message and author attribution (user + agent + key) | M |
| FR-VLT-05 | Multi-file writes are atomic (a single commit, or nothing) | M |
| FR-VLT-06 | Optimistic concurrency: writes carry the base SHA/version; conflicts return `409` with a merge hint instead of overwriting | M |
| FR-VLT-07 | Human edits pushed via Git (e.g. from Obsidian) are re-indexed via webhook within 30 s | M |
| FR-VLT-08 | Attachments (images/PDF) stored in R2, referenced from notes | S |
| FR-VLT-09 | Pluggable `VaultStore`: GitHub (v1), GitLab, and a managed DB/R2-native store for business tenants | S / C |
| FR-VLT-10 | Note templates per type | S |

### 1.2 Session ritual (`FR-SES`)

| ID | Requirement | P |
|---|---|---|
| FR-SES-01 | `brain_context(project?, budget_tokens?)` returns: project note (goal, status, next), N recent non-superseded decisions, last K session summaries, other active projects, a new `session_id` | M |
| FR-SES-02 | Context output is **token-budgeted** (default 4,000 tokens); trim order: older sessions → older decisions → project note tail. Output is compact JSON | M |
| FR-SES-03 | `brain_save(session_id, summary, work_done[], next_steps[], decisions[], topic_updates[], project_status?)` writes all in **one commit**; repeated saves with the same `session_id` update the same session log (idempotent) | M |
| FR-SES-04 | Decisions are append-only, each with `id`, `date`, `title`, `rationale`, `alternatives?`, `supersedes?`; superseded ones are hidden from agents by default | M |
| FR-SES-05 | `brain_check()` reports unsaved/abandoned sessions, stale projects (no activity in N days), broken links, near-duplicate topics. **Suggests**, never auto-applies | M |
| FR-SES-06 | Session auto-close: sessions opened but not saved within 24 h are flagged in `brain_check` | S |

### 1.3 Search and retrieval (`FR-SRC`)

| ID | Requirement | P |
|---|---|---|
| FR-SRC-01 | Heading-aware chunking: split on headings; sections > ~400 words split at paragraph breaks; hard cap ~1,500 chars; each chunk stores note title + heading path | M |
| FR-SRC-02 | Full-text search (SQLite FTS5, BM25). Query terms are sanitised/quoted (no FTS syntax injection) | M |
| FR-SRC-03 | Permission filter applied **inside** the SQL query, before `LIMIT` | M |
| FR-SRC-04 | Over-fetch, then keep best chunk per note (dedupe); return snippet + path + score | M |
| FR-SRC-05 | Session logs excluded by default; filters for `type`, `project`, `space`, `tag`, date range | M |
| FR-SRC-06 | Semantic search: embeddings in Vectorize, fused with keyword results via Reciprocal Rank Fusion (k=60); minimum similarity threshold; content-hash so only changed notes re-embed; per-run cap | S |
| FR-SRC-07 | `brain_read(path | id, section?)` returns a note or a single section | M |
| FR-SRC-08 | Graph view in web UI (notes + links) | S |
| FR-SRC-09 | "Related notes" suggestions when writing | C |

### 1.4 Access, identity and keys (`FR-IAM`)

| ID | Requirement | P |
|---|---|---|
| FR-IAM-01 | User accounts with email + passkey/magic-link, or GitHub/Google OAuth login | M |
| FR-IAM-02 | API keys **per machine and per assistant**, with scopes: `read`, `write`, optional `project:<id>` / `space:<id>` restriction, expiry | M |
| FR-IAM-03 | Keys shown once; stored server-side only as HMAC hash; revocation is immediate | M |
| FR-IAM-04 | OAuth 2.1 (PKCE, dynamic client registration) for MCP clients that support it | M |
| FR-IAM-05 | `brain login` CLI stores keys in the OS keychain and configures installed clients (Claude Code, Claude Desktop, Cursor, VS Code) | M |
| FR-IAM-06 | SSO via OIDC/SAML; SCIM provisioning | C (Business) |

### 1.5 Sharing and collaboration (`FR-SHR`). See [sharing-and-tenancy](../04-collaboration/sharing-and-tenancy.md)

| ID | Requirement | P |
|---|---|---|
| FR-SHR-01 | Every user has a private personal space | M |
| FR-SHR-02 | Share a project or a whole space with a user/email as `viewer` or `editor` | M |
| FR-SHR-03 | Recipient must **accept** before shared content can enter their agents' context | M |
| FR-SHR-04 | Permissions are checked on every request; revocation takes effect on the next request | M |
| FR-SHR-05 | Orgs with members and roles (`owner`, `admin`, `member`, `guest`); team spaces | S |
| FR-SHR-06 | Audit trail of writes, shares, permission changes, key events | M |

### 1.6 Activity logging (`FR-ACT`), optional

| ID | Requirement | P |
|---|---|---|
| FR-ACT-01 | Client hooks append agent tool calls to a local spool file; a background sender batches and retries | S |
| FR-ACT-02 | Secrets redacted on device **and** on server | S |
| FR-ACT-03 | Hot data in D1 (≤ 14 days); nightly job archives finished days to R2, one file per session | S |
| FR-ACT-04 | Hook writes never block the agent (fire-and-forget, bounded queue) | S |

### 1.7 Web app (`FR-WEB`)

| ID | Requirement | P |
|---|---|---|
| FR-WEB-01 | Dashboard: active projects, recent sessions, recent decisions, `check` findings | M |
| FR-WEB-02 | Note browser + Markdown editor with preview, frontmatter form, wikilink autocomplete | M |
| FR-WEB-03 | Search UI with filters | M |
| FR-WEB-04 | Keys & devices management; connected clients; one-click client setup snippets | M |
| FR-WEB-05 | Sharing UI, invitations inbox, audit log viewer | M |
| FR-WEB-06 | Command palette (⌘K), keyboard-first navigation, dark mode | S |
| FR-WEB-07 | Data export (zip of vault + JSON metadata) and account deletion | M |

## 2. Non-functional requirements

| ID | Category | Requirement |
|---|---|---|
| NFR-01 | Latency | p95: `brain_context` < 300 ms, `brain_search` < 200 ms, `brain_save` < 1.5 s (Git commit bound) |
| NFR-02 | Availability | 99.9% monthly for read paths; writes may queue during Git provider outages |
| NFR-03 | Durability | Zero data loss: Git is durable truth; nightly R2 backup of D1 + vault mirror |
| NFR-04 | Rebuildability | Full index rebuild from Git with **no empty-index window** (write-new-then-delete-stale) |
| NFR-05 | Scalability | Personal: 50k notes/space. Business: 10k users/org, horizontal by tenant |
| NFR-06 | Security | OWASP ASVS L2; tenant isolation tested in CI; see [security.md](../03-security/security.md) |
| NFR-07 | Privacy | GDPR: export, delete, data minimisation, DPA-ready; region pinning for Business |
| NFR-08 | Token efficiency | Compact JSON responses; every tool has a budget parameter and sane default |
| NFR-09 | Observability | Structured logs with request IDs, metrics per tool, traces; no note content in logs |
| NFR-10 | Cost | < $5/month infra for a heavy personal user; tenant cost attributable |
| NFR-11 | Portability | Core domain logic runtime-agnostic (pure TS) so self-hosting on Node/Docker is possible |
| NFR-12 | Accessibility | Web UI meets WCAG 2.2 AA |
