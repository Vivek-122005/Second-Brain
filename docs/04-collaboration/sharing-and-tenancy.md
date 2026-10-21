# Sharing & Multi-Tenancy

## 1. Hierarchy

```
Org (billing, SSO, policies)                 ← Personal users get an implicit 1-person org
 └── Space (unit of storage = one Git vault, one index partition)
      ├── kind: personal (one per user, private by default) | team
      └── Project (folder of related notes + its decision log + its sessions)
           └── Note
```

- **Isolation boundary = Space.** Each space has its own vault repo and is partitioned by `space_id` in D1. Business orgs get their own D1 database.
- A user can belong to many orgs. An agent key always acts **as one user**, never as an org.

## 2. Roles

| Level | Roles | Notes |
|---|---|---|
| Org | `owner`, `admin`, `member`, `guest` | Org admins manage members, SSO, policies, billing. Org role does **not** grant note access by itself (except owner break-glass, which is audited) |
| Space / Project grant | `viewer`, `editor`, `admin` | Granted via `grants` table; project grants are narrower than space grants; effective role = max(space grant, project grant) |
| API key | `read`, `write` + optional `space`/`project` restriction | Effective permission = role ∩ key scope |

### Permission matrix

| Action | viewer | editor | admin | owner (space) |
|---|:-:|:-:|:-:|:-:|
| Read / search notes, `brain_context` | ✔ | ✔ | ✔ | ✔ |
| `brain_save`, write notes, add decisions | | ✔ | ✔ | ✔ |
| Supersede decisions, restructure topics | | ✔ | ✔ | ✔ |
| Share / change grants | | | ✔ | ✔ |
| Connect / change vault repo, enable semantic | | | | ✔ |
| Delete space, transfer ownership | | | | ✔ |
| View audit log for the space | | | ✔ | ✔ |

## 3. Sharing flow (consent-first)

```
Owner/admin: POST /grants {space|project, email, role}
   → grant(status=pending) → audit('grant.create') → email invite
Recipient: sees invitation in inbox → Accept / Decline
   → grant(status=accepted, include_in_agent_context = user choice)
Agents of recipient:
   brain_context/search include the shared resource ONLY IF
     grant.status = 'accepted' AND include_in_agent_context = 1
     AND key scope allows it AND include_shared != false
Revocation: DELETE /grants/:id → status=revoked → KV principal cache purged → effective next request
```

Why consent? It means nobody can push content into someone else's agent context, which would be a prompt-injection vector, and recipients control how noisy their context is.

## 4. Resolving the readable set (every request)

```sql
-- spaces I own
SELECT id FROM spaces WHERE owner_user_id = :uid
UNION
-- spaces/projects shared with me and accepted
SELECT space_id FROM grants WHERE grantee_user_id = :uid AND status = 'accepted'
                                 AND (:for_agent = 0 OR include_in_agent_context = 1)
```

The result is cached in KV for 60 s per principal and purged on any grant or key change. Project-level grants add a `(space_id, project_id)` pair, and those pairs go into the SQL `WHERE` as `(space_id IN (...) OR (space_id, project_id) IN (...))`, always **inside** the query, before `LIMIT`.

## 5. Writes into shared spaces

- Commits are authored by the space's GitHub App, with a `Co-authored-by` trailer and a `Brain-Actor: user:<id> key:<id>` trailer, so Git history shows who wrote what.
- Concurrency: the per-space Durable Object serialises writes. Section-level patches (append decision, replace section) rebase cleanly; whole-note replacements with a stale `base_version` return `409`.

## 6. Business features (Phase 3+)

- **SSO** (OIDC/SAML) with domain verification and enforced SSO login; **SCIM** for provisioning and deprovisioning (deprovision revokes all keys immediately).
- **Policies:** disallow personal-space sharing outside the org domain, require key expiry ≤ 90 days, disable activity logging, set retention windows.
- **Managed vault backend:** for orgs that don't want GitHub, a `VaultStore` implementation on R2 with content-addressed versioning (same commit semantics).
- **Audit export** to SIEM (R2 drop or webhook), and an org-wide audit view.

## 7. Audit events

`auth.login`, `key.create|revoke|rotate`, `grant.create|accept|decline|revoke`, `note.write`, `session.save`, `decision.supersede`, `space.create|delete|vault.connect`, `export.request`, `policy.change`, `admin.breakglass`.
