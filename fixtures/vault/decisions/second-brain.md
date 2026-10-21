---
type: decision-log
project: second-brain
---

# Decisions: second-brain

## DEC-0001 · Run on Cloudflare Workers
- date: 2026-10-21
- status: active
- rationale: Millisecond cold starts, global edge, near-zero cost for one person.
- alternatives: Node on Fly.io, Vercel functions

## DEC-0002 · Store notes only in GitHub
- date: 2026-10-21
- status: superseded
- superseded_by: DEC-0003
- rationale: History and ownership for free.

## DEC-0003 · Managed vault by default, GitHub optional
- date: 2026-10-21
- status: active
- supersedes: DEC-0002
- rationale: Works on day one without a token; GitHub stays available for people who want their notes in their own repository.
