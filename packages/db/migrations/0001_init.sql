-- Second Brain: initial schema (LLD §2).
-- Rules: migrations are forward-only and backward-compatible (expand → migrate → contract).
-- Times are Unix epoch milliseconds (INTEGER). IDs are prefixed ULIDs (TEXT).

-- ── Identity and tenancy ────────────────────────────────────────────────────
CREATE TABLE users (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name        TEXT,
  created_at  INTEGER NOT NULL,
  deleted_at  INTEGER
);

CREATE TABLE spaces (
  id                TEXT PRIMARY KEY,
  owner_user_id     TEXT NOT NULL REFERENCES users(id),
  name              TEXT NOT NULL,
  kind              TEXT NOT NULL DEFAULT 'personal' CHECK (kind IN ('personal', 'team')),
  -- 'managed' keeps files in D1 (vault_files); 'github' commits to a GitHub repository.
  vault_provider    TEXT NOT NULL DEFAULT 'managed' CHECK (vault_provider IN ('managed', 'github')),
  vault_repo        TEXT,            -- "owner/name" for github
  vault_branch      TEXT,
  vault_token_enc   TEXT,            -- AES-GCM encrypted access token (never plaintext)
  webhook_secret_enc TEXT,
  semantic_enabled  INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL
);
CREATE INDEX spaces_owner ON spaces(owner_user_id);

-- Sharing grants (space- or project-level). Used from Phase 4; created now so authz has one shape.
CREATE TABLE grants (
  id               TEXT PRIMARY KEY,
  space_id         TEXT NOT NULL REFERENCES spaces(id),
  project_slug     TEXT,             -- NULL = whole space
  grantee_user_id  TEXT REFERENCES users(id),
  grantee_email    TEXT COLLATE NOCASE,
  role             TEXT NOT NULL CHECK (role IN ('viewer', 'editor', 'admin')),
  status           TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'declined', 'revoked')),
  include_in_agent_context INTEGER NOT NULL DEFAULT 1,
  created_by       TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  accepted_at      INTEGER,
  revoked_at       INTEGER
);
CREATE INDEX grants_grantee ON grants(grantee_user_id, status);

-- ── Credentials ────────────────────────────────────────────────────────────
CREATE TABLE api_keys (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  label         TEXT NOT NULL,
  machine       TEXT,
  client        TEXT,
  prefix        TEXT NOT NULL,       -- 'sb_live_ab12', shown in UI, used for lookup
  hash          TEXT NOT NULL,       -- hex HMAC-SHA256(pepper, secret)
  scopes        TEXT NOT NULL,       -- JSON array: ["read","write"]
  space_id      TEXT REFERENCES spaces(id),
  project_slug  TEXT,
  expires_at    INTEGER,
  last_used_at  INTEGER,
  revoked_at    INTEGER,
  created_at    INTEGER NOT NULL
);
CREATE INDEX api_keys_prefix ON api_keys(prefix);
CREATE INDEX api_keys_user ON api_keys(user_id);

CREATE TABLE web_sessions (
  id_hash       TEXT PRIMARY KEY,    -- SHA-256 of the cookie value
  user_id       TEXT NOT NULL REFERENCES users(id),
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  last_seen_at  INTEGER
);
CREATE INDEX web_sessions_user ON web_sessions(user_id);

CREATE TABLE login_tokens (
  token_hash    TEXT PRIMARY KEY,    -- SHA-256 of the magic-link token
  email         TEXT NOT NULL COLLATE NOCASE,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  used_at       INTEGER
);

CREATE TABLE device_codes (
  device_code_hash TEXT PRIMARY KEY,
  user_code     TEXT NOT NULL UNIQUE,
  client        TEXT NOT NULL,
  machine       TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'consumed')),
  user_id       TEXT REFERENCES users(id),
  scopes        TEXT,
  project_slug  TEXT,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  last_polled_at INTEGER
);

-- ── Audit (hash-chained for tamper evidence) ────────────────────────────────
CREATE TABLE audit_log (
  id             TEXT PRIMARY KEY,
  space_id       TEXT,
  actor_user_id  TEXT,
  actor_key_id   TEXT,
  action         TEXT NOT NULL,
  target         TEXT,
  metadata       TEXT,
  at             INTEGER NOT NULL,
  prev_hash      TEXT,
  hash           TEXT NOT NULL
);
CREATE INDEX audit_space_at ON audit_log(space_id, at DESC);

-- ── Managed vault store (source of truth when vault_provider = 'managed') ──
CREATE TABLE vault_files (
  space_id    TEXT NOT NULL,
  path        TEXT NOT NULL,
  content     TEXT NOT NULL,
  blob_sha    TEXT NOT NULL,         -- SHA-256 of content
  commit_id   TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (space_id, path)
);

CREATE TABLE vault_commits (
  id          TEXT PRIMARY KEY,
  space_id    TEXT NOT NULL,
  parent_id   TEXT,
  message     TEXT NOT NULL,
  author      TEXT NOT NULL,
  changes     TEXT NOT NULL,         -- JSON: [{path, op: "put"|"delete", blob_sha}]
  created_at  INTEGER NOT NULL
);
CREATE INDEX vault_commits_space ON vault_commits(space_id, created_at DESC);

-- ── Search index (rebuildable from the vault) ───────────────────────────────
CREATE TABLE notes (
  id            TEXT PRIMARY KEY,
  space_id      TEXT NOT NULL,
  path          TEXT NOT NULL,
  type          TEXT NOT NULL,
  title         TEXT NOT NULL,
  project_slug  TEXT,
  tags          TEXT NOT NULL DEFAULT '[]',
  frontmatter   TEXT NOT NULL DEFAULT '{}',
  body          TEXT NOT NULL,       -- full body: the index doubles as the read cache
  raw           TEXT NOT NULL,       -- full file including frontmatter
  content_hash  TEXT NOT NULL,       -- SHA-256 of raw; also the optimistic-concurrency version
  indexed_sha   TEXT,                -- vault commit this row reflects
  generation    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE (space_id, path)
);
CREATE INDEX notes_space_type ON notes(space_id, type);
CREATE INDEX notes_space_project ON notes(space_id, project_slug);

CREATE TABLE chunks (
  id            TEXT PRIMARY KEY,
  note_id       TEXT NOT NULL,
  space_id      TEXT NOT NULL,
  ord           INTEGER NOT NULL,
  heading_path  TEXT NOT NULL,
  body          TEXT NOT NULL,
  token_count   INTEGER NOT NULL
);
CREATE INDEX chunks_note ON chunks(note_id);
CREATE INDEX chunks_space ON chunks(space_id);

-- Standalone FTS table; rows are inserted/deleted alongside `chunks`.
CREATE VIRTUAL TABLE chunks_fts USING fts5(
  title, heading_path, body,
  chunk_id UNINDEXED, note_id UNINDEXED, space_id UNINDEXED,
  tokenize = 'porter unicode61'
);

CREATE TABLE links (
  src_note_id   TEXT NOT NULL,
  space_id      TEXT NOT NULL,
  target        TEXT NOT NULL,       -- as written
  dst_path      TEXT,                -- resolved path, NULL when broken
  PRIMARY KEY (src_note_id, target)
);
CREATE INDEX links_dst ON links(space_id, dst_path);

CREATE TABLE decisions (
  space_id       TEXT NOT NULL,
  id             TEXT NOT NULL,      -- DEC-0042
  note_id        TEXT NOT NULL,
  project_slug   TEXT,
  title          TEXT NOT NULL,
  rationale      TEXT NOT NULL,
  date           TEXT NOT NULL,
  status         TEXT NOT NULL,
  supersedes     TEXT,
  superseded_by  TEXT,
  PRIMARY KEY (space_id, id)
);
CREATE INDEX decisions_space_project ON decisions(space_id, project_slug, date DESC);

-- Agent working sessions opened by brain_context and closed by brain_save.
CREATE TABLE agent_sessions (
  id            TEXT PRIMARY KEY,
  space_id      TEXT NOT NULL,
  project_slug  TEXT,
  user_id       TEXT,
  key_id        TEXT,
  client        TEXT,
  status        TEXT NOT NULL CHECK (status IN ('open', 'saved', 'abandoned')),
  summary       TEXT,
  note_path     TEXT,
  opened_at     INTEGER NOT NULL,
  saved_at      INTEGER
);
CREATE INDEX agent_sessions_space ON agent_sessions(space_id, status, opened_at DESC);

CREATE TABLE sync_state (
  space_id           TEXT PRIMARY KEY,
  last_indexed_sha   TEXT,
  last_full_rebuild  INTEGER,
  generation         INTEGER NOT NULL DEFAULT 0
);
