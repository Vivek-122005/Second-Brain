-- Sharing (FR-SHR-02..04): indexes the grants API and the per-request readable-set lookup need.
-- Forward-only and backward-compatible: indexes only, no column changes.

-- Outgoing grants of a space ("who has access?").
CREATE INDEX IF NOT EXISTS grants_space ON grants(space_id, status);

-- Pending invitations for an email that has no account yet; attached on sign-up.
CREATE INDEX IF NOT EXISTS grants_email ON grants(grantee_email, status);

-- One live grant per (space, project, recipient). Declined and revoked grants can be re-issued.
CREATE UNIQUE INDEX IF NOT EXISTS grants_live_unique
  ON grants(space_id, COALESCE(project_slug, ''), grantee_email)
  WHERE status IN ('pending', 'accepted');
