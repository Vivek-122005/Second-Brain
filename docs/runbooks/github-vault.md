# Runbook: keep a space's vault in a GitHub repository

A space's notes normally live in the managed vault (stored by Second Brain). You can connect the space to a GitHub repository instead. Then you edit the notes in Obsidian or VS Code, push, and agents see the change within seconds. Every save from an agent becomes a commit in your repository.

Requirements: FR-VLT-07, FR-VLT-09. Design: [HLD §4.3](../02-architecture/hld.md), [ADR-0001](../adr/0001-git-as-source-of-truth.md), [ADR-0008](../adr/0008-v1-runtime-simplifications.md).

## 0. Server setup (self-hosters, once)

The server encrypts repository tokens and webhook secrets with AES-256-GCM, using a key-encryption key:

```bash
openssl rand -base64 32 | pnpm --filter @second-brain/server exec wrangler secret put VAULT_KEK
# local development: put the same kind of value in apps/server/.dev.vars as VAULT_KEK=...
```

Without `VAULT_KEK`, the connect endpoint answers `503`. Don't rotate or lose this key: stored tokens can't be decrypted without it. If it is lost, disconnect with `?skip_import=true` and reconnect each space.

## 1. Create a fine-grained token

1. On GitHub, go to **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
2. **Resource owner:** you, or the organisation that owns the repository.
3. **Repository access:** *Only select repositories*, and pick the vault repository only.
4. **Repository permissions:**
   - **Contents: Read and write** (required).
   - **Webhooks: Read and write** (optional). With it, Second Brain creates the push webhook for you.
   - Metadata: Read-only is added automatically.
5. Pick an expiry date and generate the token. Copy it now; GitHub shows it once.

The token can reach only that one repository. Second Brain stores it encrypted and never returns it.

## 2. Connect the space

Only the space owner can connect it, from the web app (Settings → Vault → Connect GitHub) or through the API:

```bash
curl -X POST "$API/api/v1/spaces/$SPACE_ID/vault/github" \
  -H "Authorization: Bearer $SECOND_BRAIN_KEY" -H 'content-type: application/json' \
  -d '{"repo":"you/notes","token":"github_pat_...","direction":"push_managed"}'
```

| Field | Meaning |
|---|---|
| `repo` | `owner/name` |
| `branch` | Optional. Defaults to the repository's default branch |
| `direction` | `push_managed`: export this space's notes to the repository as one commit, then use the repository. `adopt_repo`: import the repository's Markdown notes, then use the repository |
| `confirm_overwrite` | Needed when notes would be overwritten: the repository already has notes (`push_managed`, a root `README.md` doesn't count), or the space already has notes (`adopt_repo`) |
| `create_webhook` | Default `true`: try to create the webhook with the token |

The server checks that the token can read the repository and the branch, writes the export commit (for `push_managed`), switches the space to GitHub and rebuilds the search index. Only `.md` files are indexed. Hidden folders such as `.obsidian/` and files over 1 MB are skipped.

The response contains a `webhook` block. **The secret appears only in this response.**

```json
"webhook": {
  "payload_url": "https://your-host/webhooks/github/spc_...",
  "content_type": "application/json",
  "secret": "…",
  "events": ["push"],
  "created": false,
  "detail": "The token cannot manage webhooks …"
}
```

## 3. Add the webhook (when `created` is false)

In the repository, open **Settings → Webhooks → Add webhook**, then:

- **Payload URL:** `payload_url` from the response.
- **Content type:** `application/json`.
- **Secret:** `secret` from the response.
- **SSL verification:** enabled.
- **Which events:** *Just the push event*.

GitHub sends a `ping` right away. `GET /api/v1/spaces/$SPACE_ID/vault` then shows `"webhook": {"configured": true, …}`.

If you lose the secret, disconnect and connect again with `adopt_repo` and `confirm_overwrite: true` (the repository already holds every note). That generates a new secret and, when the token has permission, updates the existing hook.

## 4. Use it with Obsidian (Obsidian Git)

1. Clone the repository: `git clone git@github.com:you/notes.git`, and open the folder as a vault in Obsidian.
2. Install the community plugin **Obsidian Git**. In its settings, turn on *Auto pull on startup*, and set *Auto commit-and-sync interval* to a few minutes (or sync by hand with the command palette).
3. Edit notes and sync. Every push reaches Second Brain through the webhook, and only the changed `.md` files are re-indexed. Agents can see the change within seconds.
4. Agents also commit to the same branch, so pull before you edit (Obsidian Git's auto pull does this). If your push is rejected, pull, resolve the conflict and push again. Second Brain never force-pushes over your work.

VS Code or plain `git` work the same way: commit and push to the connected branch.

## 5. How sync stays correct

- Pushes to other branches are ignored. Pushes whose head commit is already indexed are skipped; these are the server's own commits, indexed at save time.
- Each delivery is verified with `X-Hub-Signature-256` (constant-time compare) and deduplicated by `X-GitHub-Delivery`.
- When a push was missed or its file list is truncated, the server compares the indexed commit with the new head through the GitHub API. After a force-push it rebuilds the whole index.
- **Drift check:** when a GitHub space is read and its last check is more than 10 minutes old, the server compares the branch head with the indexed commit and catches up in the background.
- **Nightly rebuild:** the cron job rebuilds every space's index from its vault.

`GET /api/v1/spaces/$SPACE_ID/vault` shows `last_synced_sha`, `last_synced_at` and `last_sync_error`.

## 6. Disconnect (back to the managed vault)

```bash
curl -X DELETE "$API/api/v1/spaces/$SPACE_ID/vault/github" -H "Authorization: Bearer $SECOND_BRAIN_KEY"
```

The server copies the branch's latest Markdown files into the managed vault (one managed commit), switches the space back, removes the webhook it created, deletes the stored token and secret, and rebuilds the index. No notes are lost. Non-Markdown files (images, attachments) stay in the repository only. The repository itself is not changed.

If the repository can't be read any more (token expired or revoked, repository deleted), the disconnect fails with a 400 that explains why. Use `?skip_import=true` to switch back anyway. The managed vault then holds what it had before you connected.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `400 GitHub rejected the token` | Token mistyped, expired or revoked. Create a new one |
| `400 Repository not found` | Wrong `owner/name`, or the token wasn't given access to that repository |
| `400 The token lacks permission` | Give the token **Contents: Read and write** |
| `409 … already has N notes` | Pass `confirm_overwrite: true`, or choose the other direction |
| `webhook.configured` stays false | Check the hook's *Recent deliveries* in GitHub: the payload URL must be public and the secret must match |
| `last_sync_error` is set | Usually the token: reconnect with a fresh one. The drift check and the nightly rebuild retry automatically |
