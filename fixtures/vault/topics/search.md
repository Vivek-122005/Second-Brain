---
type: topic
title: Search
tags: [architecture]
---

# Search

## Chunking

Notes are split at headings; long sections at paragraph breaks. Each chunk keeps the note title
and heading trail.

## Ranking

SQLite FTS5 with BM25, title weighted above headings above body. Every query term is quoted so
FTS operators cannot change the query. Session logs are excluded by default.

## Semantic layer

Optional embeddings merged with reciprocal rank fusion. See [[decisions/second-brain]].
