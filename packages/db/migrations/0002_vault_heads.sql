-- Head pointer per space for the managed vault store. A commit updates the head with a
-- compare-and-swap (`WHERE head IS ?expected`); every other statement in the same D1 batch is
-- guarded on the new head, so a lost race changes nothing (optimistic concurrency, ADR-0008).
CREATE TABLE vault_heads (
  space_id  TEXT PRIMARY KEY,
  head      TEXT
);
