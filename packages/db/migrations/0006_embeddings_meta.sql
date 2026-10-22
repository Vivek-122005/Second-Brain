-- Semantic search bookkeeping (ADR-0004, FR-SRC-06).
-- One row per embedded note. A note is (re-)embedded when it has no row, or when its
-- content_hash or the embedding model differs from the note's current state. chunk_count records
-- how many vectors (`<note_id>:<ord>`, ord < chunk_count) exist in Vectorize, so vectors for
-- chunks that disappeared, and for notes that were removed, can be deleted.
-- Rebuildable: dropping every row only causes a full re-embed.
CREATE TABLE embeddings_meta (
  note_id       TEXT PRIMARY KEY,
  space_id      TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  model         TEXT NOT NULL,
  chunk_count   INTEGER NOT NULL DEFAULT 0,
  embedded_at   INTEGER NOT NULL
);
CREATE INDEX embeddings_meta_space ON embeddings_meta(space_id);
