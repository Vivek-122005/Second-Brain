# Low-Level Design (LLD)

## 1. Vault format

### 1.1 Layout (per space repo)

```
/projects/<slug>.md            type: project
/topics/<slug>.md              type: topic
/decisions/<project-slug>.md   type: decision-log  (append-only, one per project + global.md)
/sessions/YYYY/MM/<date>-<session-id>.md   type: session
/inbox/*.md                    type: note (quick capture)
/.brain/config.yml             space-level settings (excluded from search)
```

### 1.2 Frontmatter schemas (Zod in `packages/schema`)

```yaml
# project
type: project
id: prj_01J...           # ULID, stable across renames
title: Billing refactor
status: active           # active | paused | done | archived
goal: Replace legacy invoicing with Stripe Billing
next: [Migrate webhooks, Backfill invoices]
tags: [payments]
updated: 2026-10-21

# session
type: session
id: ses_01J...
project: "[[projects/billing]]"
agent: claude-code
machine: macbook-pro
started: 2026-10-21T09:12:00Z
saved: 2026-10-21T11:40:00Z
summary: Migrated webhook handlers...
next: [...]

# topic
type: topic
id: top_01J...
title: Rate limiting
aliases: [throttling]
tags: [infra]
```

Decision entries live inside the decision-log body as structured blocks:

```markdown
## DEC-0042 · Use Postgres advisory locks for job dedupe
- date: 2026-10-21
- status: active            # active | superseded
- supersedes: DEC-0031
- rationale: Already on Postgres; Redis adds an ops dependency...
- alternatives: Redis SETNX, DB unique constraint
```

## 2. Database schema (D1 / SQLite)

Control-plane and identity tables:

```sql
CREATE TABLE orgs        (id TEXT PRIMARY KEY, name TEXT, plan TEXT, region TEXT, created_at INTEGER);
CREATE TABLE users       (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT,
                          created_at INTEGER, deleted_at INTEGER);
CREATE TABLE org_members (org_id TEXT, user_id TEXT, role TEXT CHECK(role IN ('owner','admin','member','guest')),
                          PRIMARY KEY (org_id, user_id));
CREATE TABLE spaces      (id TEXT PRIMARY KEY, org_id TEXT, owner_user_id TEXT, name TEXT,
                          kind TEXT CHECK(kind IN ('personal','team')),
                          vault_provider TEXT, vault_repo TEXT, vault_installation_id TEXT,
                          semantic_enabled INTEGER DEFAULT 0, created_at INTEGER);
CREATE TABLE projects    (id TEXT PRIMARY KEY, space_id TEXT NOT NULL, slug TEXT, title TEXT, status TEXT,
                          updated_at INTEGER, UNIQUE(space_id, slug));

-- Grants: one table for both space- and project-level sharing
CREATE TABLE grants      (id TEXT PRIMARY KEY, space_id TEXT NOT NULL, project_id TEXT,  -- NULL = whole space
                          grantee_user_id TEXT, grantee_email TEXT,
                          role TEXT CHECK(role IN ('viewer','editor','admin')),
                          status TEXT CHECK(status IN ('pending','accepted','declined','revoked')),
                          include_in_agent_context INTEGER DEFAULT 1,
                          created_by TEXT, created_at INTEGER, accepted_at INTEGER, revoked_at INTEGER);

CREATE TABLE api_keys    (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, label TEXT, machine TEXT, client TEXT,
                          prefix TEXT NOT NULL,            -- 'sb_live_ab12' shown in UI
                          hash BLOB NOT NULL,              -- HMAC-SHA256(pepper, secret)
                          scopes TEXT NOT NULL,            -- JSON: ["read","write"]
                          space_id TEXT, project_id TEXT,  -- optional restriction
                          expires_at INTEGER, last_used_at INTEGER, revoked_at INTEGER, created_at INTEGER);

CREATE TABLE audit_log   (id TEXT PRIMARY KEY, org_id TEXT, space_id TEXT, actor_user_id TEXT, actor_key_id TEXT,
                          action TEXT, target TEXT, metadata TEXT, ip_hash TEXT, at INTEGER,
                          prev_hash BLOB, hash BLOB);      -- hash-chained for tamper evidence
```

Index tables (rebuildable from Git):

```sql
CREATE TABLE notes   (id TEXT PRIMARY KEY, space_id TEXT NOT NULL, project_id TEXT, path TEXT NOT NULL,
                      type TEXT, title TEXT, frontmatter TEXT, content_hash TEXT, indexed_sha TEXT,
                      generation INTEGER, updated_at INTEGER, UNIQUE(space_id, path));
CREATE TABLE chunks  (id TEXT PRIMARY KEY, note_id TEXT NOT NULL, space_id TEXT NOT NULL, project_id TEXT,
                      ord INTEGER, heading_path TEXT, body TEXT, token_count INTEGER, generation INTEGER);
CREATE VIRTUAL TABLE chunks_fts USING fts5(title, heading_path, body,
                      content='chunks', content_rowid='rowid', tokenize='porter unicode61');
CREATE TABLE links   (src_note_id TEXT, dst_path TEXT, dst_note_id TEXT, space_id TEXT,
                      PRIMARY KEY (src_note_id, dst_path));
CREATE TABLE decisions (id TEXT, space_id TEXT, project_id TEXT, title TEXT, rationale TEXT, date TEXT,
                      supersedes TEXT, superseded_by TEXT, note_id TEXT, generation INTEGER,
                      PRIMARY KEY (space_id, id));
CREATE TABLE sessions (id TEXT PRIMARY KEY, space_id TEXT, project_id TEXT, user_id TEXT, key_id TEXT,
                      status TEXT CHECK(status IN ('open','saved','abandoned')), summary TEXT,
                      opened_at INTEGER, saved_at INTEGER, note_path TEXT);
CREATE TABLE embeddings_meta (note_id TEXT PRIMARY KEY, content_hash TEXT, model TEXT, embedded_at INTEGER);
CREATE TABLE sync_state (space_id TEXT PRIMARY KEY, last_indexed_sha TEXT, last_full_rebuild INTEGER);
CREATE TABLE activity_events (id TEXT PRIMARY KEY, space_id TEXT, session_id TEXT, key_id TEXT,
                      tool TEXT, args_redacted TEXT, at INTEGER);   -- hot window ≤ 14 days
```

Indexes include `chunks(space_id, project_id)`, `notes(space_id, type)`, `decisions(space_id, project_id, date DESC)`, `sessions(space_id, project_id, saved_at DESC)`, `grants(grantee_user_id, status)`, and `api_keys(prefix)`.

## 3. MCP tool contracts

Every tool takes an optional `space` and defaults to the key's default space. Every response is wrapped in an envelope:

```json
{ "_meta": {"trust":"untrusted-memory","space":"spc_..","truncated":false,"tokens":812},
  "data": { ... } }
```

| Tool | Input | Output |
|---|---|---|
| `brain_context` | `project?`, `budget_tokens=4000`, `include_shared=true` | `{project{title,status,goal,next}, decisions[], sessions[], active_projects[], session_id}` |
| `brain_save` | `session_id`, `summary`, `work_done[]`, `next_steps[]`, `decisions[{title,rationale,alternatives?,supersedes?}]`, `topic_updates[{path,section?,content,mode:append\|replace}]`, `project{status?,next?}` | `{commit_sha, paths[], decision_ids[]}` |
| `brain_search` | `query`, `types?`, `project?`, `limit=8`, `mode=hybrid\|keyword` | `[{path,title,heading,snippet,score}]` |
| `brain_read` | `path` or `id`, `section?`, `max_tokens=2000` | `{path, frontmatter, content, backlinks[]}` |
| `brain_write` | `path`, `content`, `base_version?` | `{commit_sha}` or `409 conflict` |
| `brain_projects` | `status?` | `[{slug,title,status,next[0],updated}]` |
| `brain_check` | `stale_days=14` | `{unsaved_sessions[], stale_projects[], broken_links[], duplicate_topics[], suggestions[]}` |

Tool descriptions themselves teach the ritual: "Call `brain_context` at the start of every session…".

## 4. Core algorithms (`packages/core`)

### 4.1 Chunker
1. Parse frontmatter, then the Markdown AST (remark).
2. Walk headings and keep a heading-path stack (`Billing > Webhooks > Retries`).
3. Emit one chunk per section. If a section is over 400 words, split it at paragraph boundaries. If a single block is over 1,500 chars, hard-split at a sentence boundary.
4. Chunk text = `title + heading_path + body` so a chunk makes sense on its own.

### 4.2 Search
```
q' = sanitize(q)  → each term → "term"  (drops FTS operators; prefix * only on last term)
SELECT c.note_id, c.id, bm25(chunks_fts, 5.0, 2.0, 1.0) AS s, snippet(...)
FROM chunks_fts JOIN chunks c ON ...
WHERE chunks_fts MATCH ?q AND c.space_id IN (/*readable set*/) AND (/*project scope*/)
      AND n.type != 'session' /*default*/
ORDER BY s LIMIT limit*4
→ dedupe best chunk per note → if hybrid: RRF( fts_ranks, vector_ranks , k=60 ) → top limit
```
The vector query uses the same `space_id` metadata filter in Vectorize. Results below `min_similarity=0.35` are dropped before fusion.

### 4.3 Token budgeter
Estimate tokens at chars/4 (calibrated per model family). Fill the response in priority order: project header, `next`, latest 5 decisions, latest 3 sessions, active projects. When over budget, drop the oldest session first, then the oldest decision, then truncate the project body tail. Set `_meta.truncated=true`.

### 4.4 Secret redactor
Uses regex rules (AWS, GCP, GitHub, Stripe, OpenAI/Anthropic keys, JWTs, private-key blocks, `password=`), and a Shannon-entropy check on tokens of 20+ characters. Matches become `[REDACTED:<kind>]`. The same module runs in the CLI (on the client) and in the server middleware.

### 4.5 Decision supersession
When a new decision is saved with `supersedes: DEC-x`, the system marks `DEC-x` as superseded in the same commit, by rewriting its `status` line, and records `superseded_by`. Context and search hide superseded decisions unless `include_superseded=true`.

## 5. Key sequence: idempotent save

```
brain_save(session_id=S, ...)
  SpaceWriter DO:
    if sessions[S].status == 'saved': path = sessions[S].note_path (update in place)
    files = render(session_log) + append(decisions) + patch(topics) + patch(project fm)
    sha = git.createTree(base=HEAD, files) → git.createCommit → git.updateRef(fast-forward only)
      on non-FF: refetch HEAD, rebase file patches (they are append/section patches), retry ≤3
    D1 batch: upsert notes/chunks/decisions/sessions; sync_state.last_indexed_sha = sha
    audit.record('session.save', S, sha)
```

## 6. REST API (selected)

```
POST   /api/v1/auth/magic-link        GET  /api/v1/me
GET    /api/v1/spaces                 POST /api/v1/spaces
GET    /api/v1/notes?space&type&q     GET  /api/v1/notes/:id     PUT /api/v1/notes/:id
GET    /api/v1/search?q               GET  /api/v1/graph?space
GET    /api/v1/keys                   POST /api/v1/keys          DELETE /api/v1/keys/:id
POST   /api/v1/grants                 POST /api/v1/grants/:id/accept  DELETE /api/v1/grants/:id
GET    /api/v1/audit?space&cursor     POST /api/v1/exports
POST   /webhooks/github               POST /api/v1/activity/batch
```

Errors use RFC 9457 `problem+json`. List endpoints use cursor pagination. Mutating endpoints accept an `Idempotency-Key` header.

## 7. CLI (`brain`)

```
brain login                  # device-code flow → creates key for this machine+client → OS keychain
brain connect <client>       # writes MCP config for claude-code | claude-desktop | cursor | vscode
brain hooks install          # session-start/stop + tool-call hooks where the client supports them
brain status | brain logout | brain keys rotate
```

The activity spooler writes JSONL to `~/.second-brain/spool/`. It redacts on write, a background flush sends batches of up to 100 events or every 10 s, retries use exponential backoff, and the spool is capped at 50 MB.

## 8. OAuth 2.1 for MCP clients

MCP clients (Claude Desktop and claude.ai connectors, Claude Code, Cursor, VS Code) connect with just `https://<host>/mcp`. The Worker is both the **authorization server** (issuer = its origin) and the **protected resource** (`<origin>/mcp`), following the MCP authorization spec, as decided in ADR-0005 and ADR-0007. Code: `apps/server/src/oauth/**`. Tables: migration `0004_oauth.sql`.

### 8.1 Endpoints

| Endpoint | Spec | Notes |
|---|---|---|
| `GET /.well-known/oauth-protected-resource` and `…/mcp` | RFC 9728 | `resource = <origin>/mcp`, `authorization_servers = [<origin>]`, scopes `read write` |
| `GET /.well-known/oauth-authorization-server` | RFC 8414 | S256 only, `code` only, `authorization_code` + `refresh_token`, `iss` in authorization responses |
| `POST /oauth/register` | RFC 7591 | Public clients (`none`) by default; `client_secret_post` and `client_secret_basic` also accepted. At most 20 registrations per IP per hour |
| `GET` and `POST /oauth/authorize` | OAuth 2.1 §4.1, RFC 8707 | Needs a web session; server-rendered consent page; CSRF-protected POST |
| `POST /oauth/token` | OAuth 2.1 §4.1.3, §4.3 | Code exchange with PKCE; refresh-token rotation |
| `POST /oauth/revoke` | RFC 7009 | Always 200; revoking a refresh token revokes its family |
| `GET /api/v1/oauth/grants`, `DELETE /api/v1/oauth/grants/:id` | REST | Connected apps in the web app; disconnecting revokes all of the client's tokens |

Discovery, registration, token and revocation endpoints send `Access-Control-Allow-Origin: *`, since they never read cookies. The consent page does not.

### 8.2 Flow

```
client  ─ POST /mcp (no token) ───────────▶ 401 WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource/mcp"
client  ─ GET  protected-resource metadata ▶ authorization_servers = [<origin>]
client  ─ GET  /.well-known/oauth-authorization-server
client  ─ POST /oauth/register {redirect_uris, client_name} ▶ client_id (ocl_…)
browser ─ GET  /oauth/authorize?response_type=code&client_id&redirect_uri&code_challenge&code_challenge_method=S256&state&scope&resource
            no session → 302 /login?next=<encoded full authorize URL>   (the web app signs in, then navigates back with a full page load)
            session    → consent page: client name, redirect host, scopes (read; write can be unticked), space
browser ─ POST /oauth/authorize (csrf, decision, space_id, scope_write)
            deny       → 302 redirect_uri?error=access_denied&state&iss
            approve    → upsert grant (one active per user and client) → code (60 s) → 302 redirect_uri?code&state&iss
client  ─ POST /oauth/token grant_type=authorization_code, code, code_verifier, client_id, redirect_uri, resource
            → { access_token: sb_oat_… (1 h), refresh_token: sb_ort_… (30 d), scope }
client  ─ POST /mcp   Authorization: Bearer sb_oat_…
client  ─ POST /oauth/token grant_type=refresh_token → new access and refresh token; the old refresh token is spent
```

### 8.3 Rules

- **Redirect URIs:** `https://…`; `http://localhost`, `127.0.0.1` or `[::1]` on any port (RFC 8252 §7.3: a registered loopback URI matches on any port); or the private-use schemes of known desktop clients (`cursor`, `vscode`, `vscode-insiders`, `windsurf`, `claude`), where PKCE protects the code. No fragments or credentials. An unknown client or an unregistered redirect URI gets an error page, never a redirect.
- **PKCE:** `code_challenge_method=S256` is required. The verifier is checked before the code is consumed, so a wrong verifier does not burn the code. The code is consumed atomically (`UPDATE … WHERE used_at IS NULL`) in the same D1 batch as the token inserts, which are guarded on that update winning.
- **Code replay:** a second exchange gets `invalid_grant` and revokes the tokens the first exchange minted.
- **Audience (RFC 8707):** `resource` must be `<origin>/mcp` (or absent, which means the same). Tokens store their audience and are only accepted on `/mcp`; the REST API rejects them.
- **Tokens:** opaque 256-bit random values with recognisable prefixes, stored only as SHA-256 hashes. A **family** is one code exchange and every refresh after it. Refresh tokens rotate on every use. Presenting a spent one, or losing a concurrent rotation race, is treated as theft and revokes the whole family. A refresh may narrow scopes but never widen them.
- **Principal:** `identify` routes `Bearer sb_oat_…` to `principalFromAccessToken`. It yields `via: 'oauth'`, the token's scopes narrowed by the grant, `client` = the registered client name, `keyId` = the grant id (so commits, audit rows and agent sessions are attributed to the connected app), and only the space chosen at consent.
- **Consent CSRF:** the form carries `<ts>.<HMAC(pepper, session hash, ts)>`, valid for 15 minutes, and posts with a foreign `Origin` or `Sec-Fetch-Site` are refused. The page has a strict CSP (`default-src 'none'`, `frame-ancestors 'none'`) and escapes every client-supplied value.
- **Audit:** `oauth.consent`, `oauth.consent.deny`, `oauth.token.issue`, `oauth.token.refresh`, `oauth.token.revoke`, `oauth.code.reuse`, `oauth.refresh.reuse`, `oauth.grant.revoke`.
- **Cleanup:** the nightly Cron deletes codes and tokens that expired more than a day ago.

### 8.4 Tables (`0004_oauth.sql`)

- `oauth_clients`: the registration, plus an HMAC of the registering IP for the hourly cap.
- `oauth_grants`: consent per user and client, with the chosen space and scopes. A partial unique index keeps one active grant per pair.
- `oauth_codes`: hashed, single use, with the PKCE challenge, redirect URI, audience and the family it minted.
- `oauth_tokens`: hashed access and refresh tokens with `family_id`, `used_at` and `replaced_by` for rotation, and `revoked_at`.
