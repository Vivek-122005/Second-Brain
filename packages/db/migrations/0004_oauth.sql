-- OAuth 2.1 authorization server for MCP clients (ADR-0007, LLD §8).
-- Every secret (client secrets, authorization codes, access and refresh tokens) is stored only as
-- a hash. Times are Unix epoch milliseconds.

-- Clients registered through dynamic client registration (RFC 7591).
CREATE TABLE oauth_clients (
  id                          TEXT PRIMARY KEY,   -- the client_id we issue
  name                        TEXT NOT NULL,      -- self-declared client_name
  client_uri                  TEXT,
  redirect_uris               TEXT NOT NULL,      -- JSON array, validated at registration
  grant_types                 TEXT NOT NULL,      -- JSON array
  token_endpoint_auth_method  TEXT NOT NULL
    CHECK (token_endpoint_auth_method IN ('none', 'client_secret_post', 'client_secret_basic')),
  secret_hash                 TEXT,               -- HMAC of the client secret (confidential clients)
  software_id                 TEXT,
  software_version            TEXT,
  ip_hash                     TEXT NOT NULL,      -- HMAC of the registering IP, for the hourly cap
  created_at                  INTEGER NOT NULL
);
CREATE INDEX oauth_clients_ip ON oauth_clients(ip_hash, created_at);

-- A user's consent for one client: a "connected app". At most one active grant per user and client.
CREATE TABLE oauth_grants (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  client_id     TEXT NOT NULL REFERENCES oauth_clients(id),
  space_id      TEXT NOT NULL REFERENCES spaces(id),
  scopes        TEXT NOT NULL,                    -- JSON array: ["read","write"]
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  last_used_at  INTEGER,
  revoked_at    INTEGER
);
CREATE INDEX oauth_grants_user ON oauth_grants(user_id, revoked_at);
CREATE UNIQUE INDEX oauth_grants_active ON oauth_grants(user_id, client_id) WHERE revoked_at IS NULL;

-- Authorization codes: single use, 60 s, bound to the client, redirect URI and PKCE challenge.
CREATE TABLE oauth_codes (
  code_hash       TEXT PRIMARY KEY,               -- SHA-256 of the code
  grant_id        TEXT NOT NULL REFERENCES oauth_grants(id),
  client_id       TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  redirect_uri    TEXT NOT NULL,
  code_challenge  TEXT NOT NULL,                  -- S256 only
  scopes          TEXT NOT NULL,
  resource        TEXT NOT NULL,                  -- RFC 8707 audience, e.g. https://host/mcp
  family_id       TEXT,                           -- set on exchange, so a replay can revoke it
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  used_at         INTEGER
);

-- Access (1 h) and refresh (30 d, rotating) tokens. A family is one code exchange and every
-- refresh that follows it; replaying a rotated refresh token revokes the whole family.
CREATE TABLE oauth_tokens (
  token_hash   TEXT PRIMARY KEY,                  -- SHA-256 of the token
  kind         TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
  family_id    TEXT NOT NULL,
  grant_id     TEXT NOT NULL REFERENCES oauth_grants(id),
  client_id    TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  scopes       TEXT NOT NULL,
  resource     TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  used_at      INTEGER,                           -- refresh tokens: when it was rotated
  replaced_by  TEXT,                              -- refresh tokens: hash of its successor
  revoked_at   INTEGER
);
CREATE INDEX oauth_tokens_family ON oauth_tokens(family_id);
CREATE INDEX oauth_tokens_grant ON oauth_tokens(grant_id);
CREATE INDEX oauth_tokens_expires ON oauth_tokens(expires_at);
