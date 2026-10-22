---
type: decision-log
title: Platform decisions
---

# Platform decisions

## DEC-0001 · Run on Cloudflare Workers
- date: 2026-10-21
- status: active
- rationale: Fast cold starts and near-zero cost for one person.

## DEC-0002 · Keyword search first, embeddings later
- date: 2026-10-21
- status: active
- rationale: BM25 handles identifiers and error strings; semantic recall can be added behind a flag.
