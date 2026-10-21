# Engineering Standards

How we build Second Brain like production software.

## Git workflow
- **Trunk-based development.** `main` is always deployable and protected: PR required, CI green, linear history (squash merge).
- Branch names: `feat/<scope>-<short>`, `fix/…`, `chore/…`, `docs/…`, `refactor/…`.
- **Conventional Commits** (`feat(server): add brain_search tool`). Scopes: `server`, `web`, `cli`, `core`, `schema`, `db`, `vault`, `docs`, `ci`.
- Keep PRs small (under ~400 changed lines where possible). Each PR links its requirement IDs (`FR-SES-03`).
- Releases: Changesets generates CHANGELOGs and semver, and a tag `vX.Y.Z` promotes staging to production.

## Code
- TypeScript `strict`, with no `any` without a justified `eslint-disable` comment.
- Validate at the edges with Zod and trust types inside. No I/O in `packages/core`.
- Errors: typed domain errors (`NotFound`, `Forbidden`, `Conflict`, `Validation`) mapped to `problem+json` / MCP errors in one place.
- Database access goes only through `packages/db` repositories, which require a `Principal` (tenant scoping).
- Every new D1 migration is forward-only and backward-compatible.
- Feature flags (KV) for anything risky. Remove them within 2 releases.

## Testing pyramid
| Layer | Tool | Expectation |
|---|---|---|
| Unit | Vitest | `core` ≥ 95% line coverage; pure, fast |
| Integration | `@cloudflare/vitest-pool-workers` (real D1/KV/R2 in Miniflare) | Every tool and route; **tenant-isolation suite** must pass |
| Contract | Zod schema snapshots for MCP tools | Breaking changes fail CI |
| E2E | Playwright (web) + MCP client script | Golden path: login → key → context → save → search |
| Eval | Search relevance set (`evals/search.jsonl`) | Tracked nDCG@5; regressions block merge |

## Definition of Done
- [ ] Requirements referenced and acceptance criteria met
- [ ] Tests added/updated; CI green
- [ ] Security checklist considered (authz, input validation, redaction, logging no content)
- [ ] Docs/ADR updated if behaviour or architecture changed
- [ ] Observability: logs/metrics for new paths
- [ ] Migration safe to roll back the code

## Architecture Decision Records
Any significant or hard-to-reverse choice gets an ADR in `docs/adr/NNNN-title.md` (Context → Decision → Consequences). ADRs are immutable once accepted; to change one, supersede it with a new ADR.

## Environments & secrets
- Secrets only via `wrangler secret` and GitHub Actions encrypted secrets. `.dev.vars` is gitignored.
- `gitleaks` pre-commit hook and CI scan.
