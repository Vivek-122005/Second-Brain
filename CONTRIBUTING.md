# Contributing

1. Read the [engineering standards](docs/05-delivery/engineering-standards.md).
2. Create a branch from `main`: `feat/<scope>-<short-desc>`.
3. Use [Conventional Commits](https://www.conventionalcommits.org/).
4. Open a PR using the template. Link requirement IDs (e.g. `FR-SES-03`) and any ADR.
5. CI must be green and at least one review approved. Merges are squash merges.

Architecture changes need an ADR (`docs/adr/`). Changes touching auth, sharing, storage or redaction need a security review (PR checklist).
