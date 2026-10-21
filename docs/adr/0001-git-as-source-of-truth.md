# ADR-0001: Git is the source of truth for note content

- Status: accepted
- Date: 2026-10-21

## Context
Memory must survive any bug in our own service, be editable by humans in tools they already use (Obsidian, VS Code), have full history, and never lock users in. A product sold to businesses also needs an answer to "what happens to our data if you go away?".

## Decision
Note content lives as Markdown files (YAML frontmatter + `[[wikilinks]]`) in a Git repository per space. Every server write is a commit; multi-file saves are **one atomic commit** (Git Trees API). All other stores (D1 index, Vectorize, KV) are derived and rebuildable from Git.

Access goes through a `VaultStore` interface so the GitHub implementation can later be joined by a managed (R2-backed) store for customers without GitHub (OD-5).

## Consequences
- ✅ History, diff, blame and rollback for free; human edits are first-class; zero lock-in.
- ✅ Index corruption is a cheap fix: rebuild.
- ⚠️ Write latency is bound by the Git provider API (~0.5–1.5 s); immediate index updates keep agents from noticing.
- ⚠️ Git is slow and rate-limited for reads, so reads must never hit Git (see [ADR-0003](0003-sqlite-fts-index-as-cache.md)).
- ⚠️ Concurrent writers can race on the branch ref, so writes are serialised per space through a Durable Object.
- ⚠️ We depend on GitHub availability for writes; writes are queued durably when it is down (HLD §7).

## Alternatives considered
- **Database as source of truth:** faster writes, but no human-editable files, weaker history, real lock-in.
- **Plain object storage (R2) of Markdown:** no history or merges; kept as a future `VaultStore` backend.
