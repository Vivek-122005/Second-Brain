# Runbook: deploy

How to deploy the Second Brain Worker (`apps/server`) to Cloudflare, and the configuration each environment needs. For running it locally, see [local development](local-dev.md).

## Environments

`apps/server/wrangler.jsonc` defines three: the top level (local development), `staging` and `production`. Bindings such as D1 and rate limiters are not inherited by environments, so each one lists its own.

```bash
pnpm --filter @second-brain/server exec wrangler d1 migrations apply DB --env production --remote
pnpm --filter @second-brain/server exec wrangler deploy --env production
```

Apply migrations before deploying code that needs them. Migrations are forward-only and backward-compatible, so the old code keeps working against the new schema.

## Variables (`vars` in wrangler.jsonc)

| Variable | Example | Notes |
|---|---|---|
| `ENVIRONMENT` | `production` | `development` / `test` enable dev-only conveniences (magic-link `dev_link`, RP ID fallback) |
| `SIGNUP_MODE` | `allowlist` | `open` lets anyone create an account; `allowlist` only `ALLOWED_EMAILS`. Applies to every sign-in method |
| `ALLOWED_EMAILS` | `me@example.com,partner@example.com` | Comma-separated, case-insensitive |
| `APP_ORIGINS` | `https://brain.example.com` | Extra origins allowed to make cookie-authenticated requests and passkey ceremonies |
| `EMAIL_FROM` | `Second Brain <login@brain.example.com>` | Sender for magic links |
| `WEBAUTHN_RP_ID` | `brain.example.com` | **Required for passkeys outside development.** The host the app is served on, or a parent domain of it. Changing it later invalidates every registered passkey |
| `WEBAUTHN_RP_NAME` | `Second Brain` | Shown by the authenticator when a passkey is created |

## Secrets (`wrangler secret put <NAME> --env <env>`)

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
