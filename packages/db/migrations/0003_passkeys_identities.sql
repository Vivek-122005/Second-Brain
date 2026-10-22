-- Passkeys (WebAuthn), federated identities (Google OIDC) and auth rate limiting (ADR-0007).
-- Forward-only and backward-compatible: new tables plus one nullable column.

-- When the user's email was last proven (magic link or a verified Google email). NULL means the
-- account was created by passkey sign-up and nobody has proven they own the address yet.
-- Existing users all signed up by magic link, so their email is verified.
ALTER TABLE users ADD COLUMN email_verified_at INTEGER;
UPDATE users SET email_verified_at = created_at WHERE email_verified_at IS NULL;

-- Where a magic link lands after sign-in (a same-origin path, checked when stored and used).
ALTER TABLE login_tokens ADD COLUMN next TEXT;

-- One row per registered WebAuthn credential.
CREATE TABLE passkeys (
  id              TEXT PRIMARY KEY,           -- pky_<ulid>
  user_id         TEXT NOT NULL REFERENCES users(id),
  credential_id   TEXT NOT NULL UNIQUE,       -- base64url credential ID from the authenticator
  public_key      TEXT NOT NULL,              -- base64url COSE public key
  counter         INTEGER NOT NULL DEFAULT 0, -- signature counter (0 = authenticator has none)
  transports      TEXT NOT NULL DEFAULT '[]', -- JSON array, e.g. ["internal","hybrid"]
  device_type     TEXT NOT NULL CHECK (device_type IN ('singleDevice', 'multiDevice')),
  backed_up       INTEGER NOT NULL DEFAULT 0,
  aaguid          TEXT,
  name            TEXT NOT NULL,              -- user-given label
  created_at      INTEGER NOT NULL,
  last_used_at    INTEGER
);
CREATE INDEX passkeys_user ON passkeys(user_id);

-- Single-use WebAuthn challenges (5 minutes). Looked up by the challenge echoed back in
-- clientDataJSON and consumed with a conditional UPDATE, so each can be used at most once.
CREATE TABLE webauthn_challenges (
  challenge       TEXT PRIMARY KEY,           -- base64url, 32 random bytes
  kind            TEXT NOT NULL CHECK (kind IN ('register', 'login')),
  user_id         TEXT,                       -- register: the signed-in user adding a passkey
  email           TEXT COLLATE NOCASE,        -- register: the email of a new account (sign-up)
  new_user_id     TEXT,                       -- register: the id the new account will get
  name            TEXT,                       -- register: passkey name sent with the options
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  used_at         INTEGER
);

-- Federated sign-in identities, e.g. ('google', <sub>).
CREATE TABLE identities (
  provider        TEXT NOT NULL,
  subject         TEXT NOT NULL,
  user_id         TEXT NOT NULL REFERENCES users(id),
  email           TEXT COLLATE NOCASE,
  created_at      INTEGER NOT NULL,
  last_used_at    INTEGER,
  PRIMARY KEY (provider, subject)
);
CREATE INDEX identities_user ON identities(user_id);

-- In-flight OIDC authorization requests (10 minutes, single-use). Keyed by the SHA-256 of a
-- random value held in an HttpOnly cookie, which binds the flow to the browser that started it.
CREATE TABLE oidc_flows (
  id_hash         TEXT PRIMARY KEY,
  provider        TEXT NOT NULL,
  state           TEXT NOT NULL,
  nonce           TEXT NOT NULL,
  code_verifier   TEXT NOT NULL,
  redirect        TEXT NOT NULL DEFAULT '/', -- same-origin path to return to
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  used_at         INTEGER
);

-- Fixed-window counters, used when no Workers Rate Limiting binding is configured.
-- Keys hold hashes of IPs and emails, never the raw values.
CREATE TABLE rate_limits (
  key             TEXT NOT NULL,
  window_start    INTEGER NOT NULL,
  count           INTEGER NOT NULL,
  PRIMARY KEY (key, window_start)
);
