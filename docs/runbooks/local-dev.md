# Runbook: local development

How to get Second Brain running on your machine. Keep this file in step with the tooling: if a PR changes how to set up, run or test the project, it updates this page too.

## Prerequisites

| Tool | Version | Install |
|---|---|---|
| Node.js | 22 LTS or newer (CI uses the version in `.nvmrc`) | `brew install node` or `nvm install` |
| pnpm | 10.x (pinned in `package.json` → `packageManager`) | `corepack enable` or `npm i -g pnpm@10` |
| Git | any recent | |
| Wrangler | comes with the repo as a dev dependency | no global install needed |

## First-time setup

```bash
git clone https://github.com/Vivek-122005/Second-Brain.git
cd Second-Brain
pnpm install
pnpm check        # format, lint, typecheck, test: the same gates as CI
```

## Everyday commands

| Command | What it does |
|---|---|
| `pnpm dev` | Runs every app's dev server through Turborepo |
| `pnpm test` | Runs all unit and integration tests |
| `pnpm typecheck` | Type-checks every package |
| `pnpm lint` | ESLint over the whole repo (zero warnings allowed) |
| `pnpm format` | Formats code with Prettier |
| `pnpm check` | All of the above checks, as CI runs them |
| `pnpm --filter <package> <script>` | Runs a script in one package, e.g. `pnpm --filter @second-brain/core test` |

## Run the server locally

The API, MCP server and web app are one Cloudflare Worker (`apps/server`), running locally on Miniflare with a local D1 database. No Cloudflare account is needed.

```bash
cp apps/server/.dev.vars.example apps/server/.dev.vars   # then set KEY_PEPPER to any random string
pnpm --filter @second-brain/server db:migrate:local      # create the local D1 schema
pnpm --filter @second-brain/server dev                   # http://localhost:8787
```

1. **Sign in.** Add your email to `ALLOWED_EMAILS` in `apps/server/wrangler.jsonc` (or set `SIGNUP_MODE` to `open` for local use). Then `POST /api/v1/auth/magic-link`: in development the response contains a `dev_link` to open instead of an email. The web app's sign-in screen shows it as a button.
2. **Create an API key** in the web app (Keys & Devices), or with the CLI: `brain login --api http://localhost:8787`.
3. **Load the sample vault** (`fixtures/vault`):

   ```bash
   SECOND_BRAIN_KEY=sb_live_... pnpm --filter @second-brain/server seed
   ```

4. **Connect an assistant**, e.g. Claude Code:

   ```bash
   claude mcp add --transport http second-brain http://localhost:8787/mcp --header "Authorization: Bearer sb_live_..."
   ```

   or `brain connect claude-code`. Then start a session and ask it to call `brain_context`.

   To try the OAuth flow instead, leave out the header (`claude mcp add --transport http second-brain http://localhost:8787/mcp`) and run `/mcp` → **Authenticate** in Claude Code. The browser opens the consent page at `/oauth/authorize`, after sign-in if needed.

Semantic search (Workers AI + Vectorize) has no local emulator, so local dev runs keyword-only and search responses say `semantic: "unavailable"` once a space has it enabled. Tests cover the semantic layer with in-memory fakes (`apps/server/test/fakes.ts`); the relevance eval runs with `pnpm --filter @second-brain/server eval:search`.

The nightly index rebuild (and the embedding catch-up) runs on a Cron trigger. To run it locally, start with `wrangler dev --test-scheduled` and open `http://localhost:8787/__scheduled`.

### Tests that use the Workers runtime

`packages/db` and `apps/server` tests run inside workerd with a real D1 (via `@cloudflare/vitest-plugin`), with migrations from `packages/db/migrations` applied in a setup file. They need no network or account.

`apps/server/test/isolation.test.ts` is the tenant-isolation suite: what one user can reach of another's space through every read and write path as grants are created, accepted, narrowed to a project, hidden from agents and revoked. Any change to authz, sharing or a query in `packages/db` must keep it green; new read paths get a case there.

### Trying sharing locally

Sign in as two users (two browsers, or one private window). As the first, `POST /api/v1/grants {space_id, email, role}`; without `RESEND_API_KEY` the invite email is printed to the `wrangler dev` console. As the second, `GET /api/v1/invitations` and `POST /api/v1/grants/:id/accept {"include_in_agent_context": true}`.

## Branches and pull requests

1. Start from an up-to-date `main`: `git switch main && git pull`.
2. Create a branch: `feat/<scope>-<short>`, `fix/…`, `chore/…`, `docs/…`, `ci/…`.
3. Commit with Conventional Commits, with a body that says what changed, how and why.
4. Push and open a PR into `main`. CI must be green before merging (squash merge).

See [CONTRIBUTING.md](../../CONTRIBUTING.md) and [Engineering standards](../05-delivery/engineering-standards.md) for the full rules.

## Troubleshooting

- **`pnpm: command not found`**: run `corepack enable`, or install it with `npm i -g pnpm@10`.
- **Lockfile errors in CI** (`ERR_PNPM_OUTDATED_LOCKFILE`): run `pnpm install` locally and commit `pnpm-lock.yaml`.
