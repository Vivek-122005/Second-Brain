# ADR-0001: Git repository is the source of truth for note content

- Status: accepted
- Date: 2026-10-21

## Context
Users must own their memory, be able to edit it with any tool (Obsidian, VS Code) and see full history. The database must be disposable.

## Decision
Note content lives in a Git repository per space, accessed via a GitHub App. Every write is a commit, and multi-file writes are one commit. All Git access goes through a `VaultStore` interface.

## Consequences
- History, diff, blame and backup come free, and there is no lock-in.
- Write latency is bound by the Git provider API (~0.5–1.5 s). Mitigated by serialising writes per space in a Durable Object and doing immediate index updates.
- Provider rate limits mean reads must never hit Git (see ADR-0003).
- Businesses without GitHub need another `VaultStore` (managed R2 store, Phase 5).

## Alternatives considered
DB as source of truth (simpler, but lock-in and no human-editable vault). R2 objects only (no history semantics).
