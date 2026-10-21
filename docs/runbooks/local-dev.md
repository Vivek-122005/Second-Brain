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

## Branches and pull requests

1. Start from an up-to-date `main`: `git switch main && git pull`.
2. Create a branch: `feat/<scope>-<short>`, `fix/…`, `chore/…`, `docs/…`, `ci/…`.
3. Commit with Conventional Commits, with a body that says what changed, how and why.
4. Push and open a PR into `main`. CI must be green before merging (squash merge).

See [CONTRIBUTING.md](../../CONTRIBUTING.md) and [Engineering standards](../05-delivery/engineering-standards.md) for the full rules.

## Troubleshooting

- **`pnpm: command not found`**: run `corepack enable`, or install it with `npm i -g pnpm@10`.
- **Lockfile errors in CI** (`ERR_PNPM_OUTDATED_LOCKFILE`): run `pnpm install` locally and commit `pnpm-lock.yaml`.
