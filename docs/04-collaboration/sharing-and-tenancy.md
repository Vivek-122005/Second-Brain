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

Implemented in `apps/server/src/authz` (`PERMISSIONS`, `effectiveRole`, `can`, `readScope`). Two rules beyond the table:

- **Sharing is people-only.** Creating, changing or revoking grants, accepting invitations and toggling `include_in_agent_context` need a web session; API keys and OAuth tokens get `403` whatever their scopes. A prompt-injected agent must not be able to share your memory with someone else or pull content into your context.
- **Project-level grants only cover that project's notes** (`notes.project_slug`, i.e. `projects/<slug>.md`, `decisions/<slug>.md` and notes whose frontmatter names the project). A project-only editor can't write project-less files (topics, inbox) or move a file between projects; both the indexed note and the new content are checked. Import needs a space-wide editor role.

## 3. Sharing flow (consent-first)

```
Owner/admin: POST /grants {space_id, project?, email, role}
   → grant(status=pending) → audit('grant.create') → email invite (console log in dev)
   (an email with no account yet: the grant waits and attaches when that email signs up)
Recipient: GET /invitations → POST /grants/:id/accept {include_in_agent_context} | /decline
   → grant(status=accepted, include_in_agent_context = user choice, default false)
Agents of recipient:
   brain_context/search include the shared resource ONLY IF
     grant.status = 'accepted' AND include_in_agent_context = 1
     AND key scope allows it AND include_shared != false
Changes: PATCH /grants/:id {role} (admins) | {include_in_agent_context} (recipient)
Revocation: DELETE /grants/:id → status=revoked → effective next request
```

Every grant change is audited (`grant.create|accept|decline|update|revoke`, IDs only). Results from a shared space carry `source: {space, space_name, owner}`; agents pass `source.space` back as `space_id` to read or write there.

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

v1 resolves this on every request (`services/spaces.ts` `readableSpaces`) with no cache, so a revoke or a toggle applies to the very next request. If a KV cache is added later it must be purged on any grant or key change. Project-level grants add a `space_id:project` token to the read scope, and the scope goes into the SQL `WHERE` as `(space_id IN (...) OR space_id || ':' || project_slug IN (...))`, always **inside** the query, before `LIMIT` (`packages/db` `IN_SCOPE`).

## 5. Writes into shared spaces

- Commits are authored as the person writing, with a `Second-Brain-Actor: user:<id> key:<id>` trailer (next to the client, machine and key-prefix trailers), so history shows who wrote what. With the GitHub App the commit author is the App and the same trailers carry the actor.
- Writes name the target with `space_id` (MCP tools and REST). A session opened by `brain_context` on a shared project is saved in that space when the caller may write there; a viewer's session stays in their own space.
- Concurrency: the per-space Durable Object serialises writes. Section-level patches (append decision, replace section) rebase cleanly; whole-note replacements with a stale `base_version` return `409`.

## 6. Business features (Phase 3+)

- **SSO** (OIDC/SAML) with domain verification and enforced SSO login; **SCIM** for provisioning and deprovisioning (deprovision revokes all keys immediately).
- **Policies:** disallow personal-space sharing outside the org domain, require key expiry ≤ 90 days, disable activity logging, set retention windows.
- **Managed vault backend:** for orgs that don't want GitHub, a `VaultStore` implementation on R2 with content-addressed versioning (same commit semantics).
- **Audit export** to SIEM (R2 drop or webhook), and an org-wide audit view.

## 7. Audit events

`auth.login`, `key.create|revoke|rotate`, `grant.create|accept|decline|update|revoke`, `note.write`, `session.save`, `decision.supersede`, `space.create|delete|vault.connect`, `export.request`, `policy.change`, `admin.breakglass`.
