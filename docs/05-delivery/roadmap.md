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

## Phase 1 breakdown (next up)

1. Initialise monorepo: pnpm + Turborepo, `packages/config` (tsconfig strict, ESLint, Prettier), Vitest.
2. `packages/schema`: Zod schemas for frontmatter and tool I/O.
3. `packages/core`: frontmatter parser, wikilink parser, chunker, FTS query sanitiser (100% unit-tested).
4. `packages/db`: D1 migrations `0001_init.sql`, tenant-scoped repository.
5. `apps/server`: Hono app, `/health`, `/mcp` with `brain_search` and `brain_read`, and a bearer-key middleware.
6. Seed script: index `fixtures/vault/` into local D1.
7. GitHub Actions: lint → typecheck → test → deploy preview, plus `wrangler deploy --env staging` on main.
8. Docs: `docs/runbooks/local-dev.md`.

## Open decisions

| # | Decision | Options | Leaning |
|---|---|---|---|
| OD-1 | Licence | Proprietary · AGPL + commercial · BSL · MIT core + closed enterprise | Open-core: AGPL core, commercial Business features |
| OD-2 | Product name / domain | "Second Brain" is generic and hard to trademark | Keep as working name; pick brand before Phase 5 |
| OD-3 | Auth provider | Build on `@oslojs`/WebAuthn ourselves · Clerk · WorkOS (SSO later) | Own auth for personal; WorkOS for SSO/SCIM in Phase 5 |
| OD-4 | Embedding model | Workers AI bge-base · Voyage · OpenAI | Workers AI (no extra vendor), abstracted behind `Embedder` |
| OD-5 | Vault for non-GitHub users | Require GitHub · managed R2 store from day one | GitHub first; managed store in Phase 5 |
