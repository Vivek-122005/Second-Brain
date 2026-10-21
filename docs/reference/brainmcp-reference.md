# Reference: BrainMCP design overview

Source: <https://uchhdnbxbcsd.postplan.dev/> (read 2026-10-21). This is our own summary of the design we are adapting, not a copy.

## What it is
A shared "second brain" that gives AI assistants persistent memory over MCP. A Markdown vault in Git is the source of truth, with a SQLite search index as a rebuildable cache, served from Cloudflare Workers.

## Key ideas we adopt
| Idea | Where it lands in our plan |
|---|---|
| Git = source of truth, index = cache | [ADR-0001](../adr/0001-git-as-source-of-truth.md), [ADR-0003](../adr/0003-sqlite-fts-index-as-cache.md) |
| Reads from index, writes as commits, index updated immediately | HLD §4.1–4.2 |
| Multi-file saves in one atomic commit | FR-VLT-05, LLD §5 |
| Push-triggered sync + nightly rebuild, write-new-before-delete-stale | HLD §4.3–4.4, NFR-04 |
| Heading-aware chunking keeping title + heading | LLD §4.1 |
| FTS with sanitised queries, sessions excluded, dedupe per note, permission filter inside query | LLD §4.2 |
| Optional embeddings + RRF, content-hash re-embed, per-run cap, similarity floor | [ADR-0004](../adr/0004-hybrid-search-rrf.md) |
| Session ritual: context → save → check; token-budgeted; superseded decisions hidden | FR-SES-* |
| Memory is untrusted data; responses labelled | Security §4 |
| Secrets stripped client + server | LLD §4.4 |
| Per-machine, per-assistant scoped keys in OS keychain; OAuth | FR-IAM-* |
| Activity hooks, batched, non-blocking, archived to object storage | FR-ACT-* |
| Per-user spaces, viewer/editor sharing, consent, per-request checks, audit | Sharing doc |
| Compact JSON responses (≈⅓–⅔ smaller) | NFR-08 |

## What we add for a product (beyond the reference)
- Multi-tenant orgs, per-org databases, data residency, SSO/SCIM, BYOK
- A web app for humans (editor, graph, keys, sharing, audit)
- Envelope encryption for sensitive fields, a hash-chained audit log
- Per-space write serialisation (Durable Objects) and optimistic concurrency
- A formal requirements and test strategy, ADRs and CI/CD
- A pluggable `VaultStore` so businesses don't need GitHub

## Lessons carried over
One source of truth. Never empty an index before refilling it. Group related writes. Test against serverless DB limits (D1 batch and row size limits). Treat context as scarce. Treat all agent-readable content as untrusted.
