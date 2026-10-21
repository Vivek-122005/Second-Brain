# Roadmap

Build order follows the reference design's lesson: **the session ritual delivers most of the value**, so we reach a usable daily loop as early as possible and then harden.

| Phase | Goal | Scope | Exit criteria |
|---|---|---|---|
| **0: Plan** ✅ | Shared understanding | Vision, requirements, HLD/LLD, security, ADRs, repo standards | This repo |
| **1: Walking skeleton** | MCP server you can connect to | Monorepo, CI, Worker with `/mcp`, one hard-coded key, `brain_read`/`brain_search` over a local fixture vault indexed into D1 | Claude Code connects and searches a sample vault; CI green; staging deploy |
| **2: Daily driver (personal)** | Use it every day | GitHub App vault, webhook sync, nightly rebuild, `brain_context` / `brain_save` / `brain_check`, decisions + supersession, token budgeter, redactor, real API keys + `brain login` CLI, minimal web UI (notes, search, keys) | One week of real daily use with zero re-explaining; p95 targets met |
| **3: Polish & semantic** | Smarter, nicer | Hybrid search (Vectorize + RRF), graph view, editor with wikilink autocomplete, ⌘K, activity logging hooks + R2 archive, export/delete, OAuth 2.1 for MCP | Search quality eval set ≥ 0.8 nDCG@5 |
| **4: Sharing & teams** | Collaborate | Orgs, team spaces, grants with consent, audit log UI, rate limits per tenant, private encrypted sections | 3-person dogfood team for 2 weeks |
| **5: Business** | Sellable | SSO/SCIM, per-org D1 + residency, BYOK, policies, managed vault backend, billing (Stripe), status page, SOC 2 prep, pen-test | First paying design partner |

## Work breakdown

Each line is one branch and one pull request into `main` (trunk-based, squash merge, CI must be green). Requirement IDs go in the PR description.

### Phase 1: walking skeleton

| # | Branch | Delivers |
|---|---|---|
| 1.1 | `chore/monorepo-foundation` | pnpm workspaces + Turborepo, shared tsconfig (strict) / ESLint / Prettier, Vitest, `.nvmrc`, GitHub Actions CI (lint, typecheck, test, build), PR template, CODEOWNERS, Dependabot, and the local setup guide `docs/runbooks/local-dev.md` |
| 1.2 | `feat/schema-core` | `packages/schema` (Zod frontmatter + MCP tool I/O) and `packages/core`: frontmatter and wikilink parsers, heading-aware chunker, FTS query sanitiser, secret redactor, token budgeter, decision-log parser, RRF. No I/O, fully unit-tested |
| 1.3 | `feat/db-index` | `packages/db`: D1 migration `0001_init.sql`, principal-scoped repositories, indexer that turns notes into rows (write-new-then-delete-stale) |
| 1.4 | `feat/server-mcp` | `apps/server`: Hono Worker, `/health`, `/mcp` (Streamable HTTP) with `brain_search` and `brain_read`, bearer-key middleware, fixture vault + seed script |
| 1.5 | `ci/deploy-staging` | Wrangler environments and a deploy workflow (staging on `main`, production on tag) |

> **About `docs/runbooks/local-dev.md`:** it doesn't exist yet. It is a Phase 1 deliverable, written in 1.1 together with the tooling it describes.

### Phase 2: daily driver

| # | Branch | Delivers |
|---|---|---|
| 2.1 | `feat/vault-store` | `VaultStore` interface with an in-memory/local implementation (dev, tests) and a GitHub implementation (Git Trees API, one atomic commit per save, fast-forward only with retry). Starts with a fine-grained personal access token per space; the GitHub App arrives in Phase 3 |
| 2.2 | `feat/session-ritual` | `brain_context`, `brain_save`, `brain_check`, `brain_projects`, `brain_write`; decision supersession; token budget; untrusted-memory envelope |
| 2.3 | `feat/sync` | GitHub webhook (HMAC) → queue → re-index changed paths; nightly full rebuild via Cron |
| 2.4 | `feat/auth-keys` | Users, sign-in (magic link; console delivery in dev), sessions, API keys (HMAC-hashed, scoped, revocable), REST `/api/v1` |
| 2.5 | `feat/web-app` | React web app (Apple-inspired, minimal): dashboard, notes browser + editor, search, keys & devices |
| 2.6 | `feat/cli` | `brain login`, `brain connect <client>`, `brain status`; keys in the OS keychain |

### Phase 3 to 5
Scope as in the table above; each item will get its own branch row here when the phase starts.

## Decisions log

| # | Decision | Options | Leaning |
|---|---|---|---|
| OD-1 | Licence | Proprietary · AGPL + commercial · BSL · MIT core + closed enterprise | **Decided:** fully open source, AGPL-3.0 |
| OD-2 | Product name / domain | "Second Brain" is generic and hard to trademark | **Decided:** "Second Brain" (owner may rebrand later) |
| OD-3 | Auth provider | Build on `@oslojs`/WebAuthn ourselves · Clerk · WorkOS (SSO later) | **Decided:** own auth, no external provider ([ADR-0007](../adr/0007-own-authentication.md)) |
| OD-4 | Embedding model | Workers AI bge-base · Voyage · OpenAI | Workers AI (no extra vendor), abstracted behind `Embedder` |
| OD-5 | Vault for non-GitHub users | Require GitHub · managed R2 store from day one | **Decided:** managed (D1) store by default + GitHub option ([ADR-0008](../adr/0008-v1-runtime-simplifications.md)) |
