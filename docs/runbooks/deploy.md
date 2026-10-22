# Runbook: deploy

Second Brain runs as one Cloudflare Worker per environment (`second-brain-staging`, `second-brain-production`), each with its own D1 database. GitHub Actions deploys it: every merge to `main` goes to **staging**, and every tag `vX.Y.Z` goes to **production** (`.github/workflows/deploy.yml`). Migrations in `packages/db/migrations` run before each deploy.

## One-time setup (owner)

1. **Cloudflare account**: sign in at dash.cloudflare.com. The Workers free plan is enough to start; Workers Paid ($5/month) raises D1 and CPU limits.
2. **Create the databases** (from `apps/server`, after `pnpm exec wrangler login`):

   ```bash
   pnpm exec wrangler d1 create second-brain-staging
   pnpm exec wrangler d1 create second-brain-production
   ```

   Put each printed `database_id` into `apps/server/wrangler.jsonc` under `env.staging` and `env.production`, and commit that change.
3. **Set Worker secrets** for each environment (`--env staging`, then `--env production`):

   ```bash
   openssl rand -base64 32 | pnpm exec wrangler secret put KEY_PEPPER --env staging
   openssl rand -base64 32 | pnpm exec wrangler secret put VAULT_KEK --env staging
   pnpm exec wrangler secret put RESEND_API_KEY --env staging   # for sign-in emails
   pnpm exec wrangler secret put GOOGLE_CLIENT_ID --env staging      # optional: Google sign-in
   pnpm exec wrangler secret put GOOGLE_CLIENT_SECRET --env staging  # (see below)
   ```

   Never reuse a pepper between environments, and never rotate `KEY_PEPPER` casually: it invalidates every API key.
4. **Allow your email** by setting `ALLOWED_EMAILS` (and `APP_ORIGINS`, your site's origin) in `wrangler.jsonc` for each environment. Set `EMAIL_FROM` to a sender on a domain verified in Resend, and `WEBAUTHN_RP_ID` to the site's host so passkeys work (see [Passkeys](#passkeys-webauthn)).
5. **GitHub environments**: in the repository settings, create the environments `staging` and `production`. Add secrets `CLOUDFLARE_API_TOKEN` (a token with *Workers Scripts: Edit*, *D1: Edit* and *Account Settings: Read*) and `CLOUDFLARE_ACCOUNT_ID` to each, and a variable `APP_URL` (e.g. `https://second-brain-staging.<you>.workers.dev`) for the smoke test. Add yourself as a required reviewer on `production`.

Until step 5 is done, the Deploy workflow skips with a notice instead of failing.

6. **Semantic search (optional, ADR-0004).** `wrangler.jsonc` binds Workers AI (`AI`) and a Vectorize index (`VECTORIZE`) in `staging` and `production`. Create each index once, with its metadata indexes, **before the first deploy that uses it** (vectors written before a metadata index exists are not filterable by that property):

   ```bash
   # staging
   pnpm exec wrangler vectorize create second-brain-staging --dimensions=768 --metric=cosine
   pnpm exec wrangler vectorize create-metadata-index second-brain-staging --property-name=space_id --type=string
   pnpm exec wrangler vectorize create-metadata-index second-brain-staging --property-name=note_id --type=string
   pnpm exec wrangler vectorize create-metadata-index second-brain-staging --property-name=project --type=string
   pnpm exec wrangler vectorize create-metadata-index second-brain-staging --property-name=type --type=string

   # production
   pnpm exec wrangler vectorize create second-brain-production --dimensions=768 --metric=cosine
   pnpm exec wrangler vectorize create-metadata-index second-brain-production --property-name=space_id --type=string
   pnpm exec wrangler vectorize create-metadata-index second-brain-production --property-name=note_id --type=string
   pnpm exec wrangler vectorize create-metadata-index second-brain-production --property-name=project --type=string
   pnpm exec wrangler vectorize create-metadata-index second-brain-production --property-name=type --type=string

   # check
   pnpm exec wrangler vectorize list-metadata-index second-brain-staging
   ```

   Give the deploy token (`CLOUDFLARE_API_TOKEN`) the extra permissions *Vectorize: Edit* and *Workers AI: Read*. Workers AI needs no setup beyond the binding.

   Semantic search is **off per space** until the space owner turns it on, signed in to the web app. API keys and OAuth tokens are refused, so an agent cannot send your notes to the embedding model by itself. From a signed-in browser session:

   ```bash
   curl -X PATCH "$APP_URL/api/v1/spaces/<space_id>" \
     -H "cookie: sb_session=<your session cookie>" -H "origin: $APP_URL" \
     -H 'content-type: application/json' -d '{"semantic_enabled": true}'
   ```

   Turning it on embeds up to 200 chunks at once; the nightly Cron embeds the rest (200 chunks per run by default, `SEMANTIC_CRON_CHUNK_CAP` to change), so a large vault is spread over several nights. After that only notes whose content hash changed are re-embedded. Turning it off deletes the space's vectors. If the bindings are missing or failing, search silently falls back to keyword and responses say `semantic: "unavailable"`.

   **Changing the embedding model:** set the `EMBEDDING_MODEL` var; every note is re-embedded over the following runs. A model with a different dimension needs a new index (create it, point `index_name` at it, deploy).

## Releasing to production

```bash
git switch main && git pull
git tag v0.1.0 && git push origin v0.1.0
```

Approve the `production` deployment in the Actions tab. Roll back with `pnpm exec wrangler rollback --env production` (Worker code only; migrations are forward-only and backward-compatible by rule).

## Configuration reference

### Variables (`vars` in wrangler.jsonc)

| Variable | Example | Notes |
|---|---|---|
| `ENVIRONMENT` | `production` | `development` / `test` enable dev-only conveniences (magic-link `dev_link`, RP ID fallback) |
| `SIGNUP_MODE` | `allowlist` | `open` lets anyone create an account; `allowlist` only `ALLOWED_EMAILS`. Applies to every sign-in method |
| `ALLOWED_EMAILS` | `me@example.com,partner@example.com` | Comma-separated, case-insensitive |
| `APP_ORIGINS` | `https://brain.example.com` | Extra origins allowed to make cookie-authenticated requests and passkey ceremonies |
| `EMAIL_FROM` | `Second Brain <login@brain.example.com>` | Sender for magic links |
| `WEBAUTHN_RP_ID` | `brain.example.com` | **Required for passkeys outside development.** The host the app is served on, or a parent domain of it. Changing it later invalidates every registered passkey |
| `WEBAUTHN_RP_NAME` | `Second Brain` | Shown by the authenticator when a passkey is created |

### Secrets (`wrangler secret put <NAME> --env <env>`)

| Secret | Required | Notes |
|---|---|---|
| `KEY_PEPPER` | yes | HMAC pepper for API key hashes. `openssl rand -base64 32` |
| `VAULT_KEK` | for GitHub vaults | Base64 32-byte key that encrypts stored vault tokens |
| `RESEND_API_KEY` | for magic links | Without it, production has no magic-link sign-in (`/auth/providers` reports `magic_link: false`) |
| `GOOGLE_CLIENT_ID` | for Google sign-in | See below. Set as a secret (not a var) so the two Google values live together |
| `GOOGLE_CLIENT_SECRET` | for Google sign-in | Google sign-in is enabled only when both Google values are set |

Make sure at least one sign-in method works before inviting anyone: passkeys need `WEBAUTHN_RP_ID`, magic links need `RESEND_API_KEY`, Google needs both Google secrets.

## Sign in with Google: OAuth client setup

1. Open the [Google Cloud console](https://console.cloud.google.com/) and pick or create a project.
2. **APIs & Services → OAuth consent screen.** Choose *External* (or *Internal* for a Google Workspace org), fill in the app name and support email, and add the scopes `openid`, `email` and `profile`. While the app is in *Testing*, add your users as test users, or publish it.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID.** Application type: *Web application*.
4. Under **Authorized redirect URIs** add, for each host you deploy to:

   ```
   https://<host>/api/v1/auth/google/callback
   ```

   For local development also add `http://localhost:8787/api/v1/auth/google/callback`. The redirect URI must match exactly, including scheme and port. No JavaScript origins are needed.
5. Copy the client ID and secret into the Worker:

   ```bash
   cd apps/server
   wrangler secret put GOOGLE_CLIENT_ID --env production
   wrangler secret put GOOGLE_CLIENT_SECRET --env production
   ```

6. Check `GET https://<host>/api/v1/auth/providers` reports `"google": true`, then sign in once end to end.

The server finds Google's endpoints and signing keys from `https://accounts.google.com/.well-known/openid-configuration` and caches them for an hour per isolate, so key rotation needs no action. A Google account links to an existing Second Brain account with the same verified email; otherwise a new account is created if `SIGNUP_MODE` / `ALLOWED_EMAILS` allow it.

## Passkeys (WebAuthn)

Set `WEBAUTHN_RP_ID` to the host users visit (for `https://brain.example.com`, use `brain.example.com`). WebAuthn only works over HTTPS (or `http://localhost`), and the browser only offers passkeys whose RP ID matches the page's host or a parent domain. If you serve the web app from another origin, add it to `APP_ORIGINS`; origins whose host doesn't match the RP ID are ignored for passkeys.

## Rate limiting

`wrangler.jsonc` declares two [Workers Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) bindings per environment:

| Binding | Applies to | Default |
|---|---|---|
| `AUTH_RATE_LIMITER` | `/api/v1/auth/*`, per IP and per email | 30 requests / 60 s |
| `API_RATE_LIMITER` | `/api/v1/*` and `/mcp`, per API key (or user, or IP when anonymous) | 600 requests / 60 s |

Each `namespace_id` must be unique within the Cloudflare account, so change them if another Worker already uses `1001`–`3002`. Limits are tuned in `wrangler.jsonc`. If the bindings are removed, the Worker falls back to a D1 fixed-window counter using `RATE_LIMIT_AUTH_PER_MIN` / `RATE_LIMIT_API_PER_MIN` (same defaults). Over the limit, clients get `429` problem+json with `Retry-After`.
