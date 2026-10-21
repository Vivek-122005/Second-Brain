# Contributing to Second Brain

Thanks for helping. The full rules are in [Engineering standards](docs/05-delivery/engineering-standards.md); this is the short version.

## Before you start
- Read the [README](README.md), [Requirements](docs/01-product/requirements.md) and [HLD](docs/02-architecture/hld.md).
- Pick or open an issue and reference its requirement IDs (e.g. `FR-SES-03`).
- Big or hard-to-reverse changes need an [ADR](docs/adr/) first.

## Workflow
1. Branch from `main`: `feat/<scope>-<short>`, `fix/…`, `docs/…`, `chore/…`, `refactor/…`.
2. Commit with [Conventional Commits](https://www.conventionalcommits.org/): `feat(server): add brain_search tool`.
   Scopes: `server`, `web`, `cli`, `core`, `schema`, `db`, `vault`, `docs`, `ci`.
3. Keep PRs small (under ~400 changed lines where possible).
4. CI must be green: typecheck, lint, unit, integration (Workers pool), tenant-isolation suite, `gitleaks`.
5. Squash-merge after review.

## Local development
Setup, everyday commands and troubleshooting: [docs/runbooks/local-dev.md](docs/runbooks/local-dev.md). Run `pnpm check` before pushing; it runs the same gates as CI.

## Definition of Done
- Requirements referenced and acceptance criteria met
- Tests added or updated
- Security considered: authz, input validation, redaction, no note content in logs
- Docs/ADR updated when behaviour or architecture changes
- Migration is safe to roll back the code

## Security issues
Do not open public issues for vulnerabilities. See [SECURITY.md](SECURITY.md).
