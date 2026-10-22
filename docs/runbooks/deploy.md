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
   ```

   Never reuse a pepper between environments, and never rotate `KEY_PEPPER` casually: it invalidates every API key.
4. **Allow your email** by setting `ALLOWED_EMAILS` (and `APP_ORIGINS`, your site's origin) in `wrangler.jsonc` for each environment. Set `EMAIL_FROM` to a sender on a domain verified in Resend.
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
