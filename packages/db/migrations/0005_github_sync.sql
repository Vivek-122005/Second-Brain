-- GitHub vault sync: connect API, push webhooks and the drift check (HLD §4.3, FR-VLT-07).
-- Additive only: new nullable columns and a new table, so older code keeps working.

-- Id of the push webhook we created on the repository (NULL when the owner added it by hand).
ALTER TABLE spaces ADD COLUMN webhook_id INTEGER;
-- Last time a correctly signed delivery (ping or push) arrived: proof the webhook is set up.
ALTER TABLE spaces ADD COLUMN webhook_last_delivery_at INTEGER;

-- When the index was last confirmed to match the vault head (webhook sync, drift check, connect).
ALTER TABLE sync_state ADD COLUMN last_synced_at INTEGER;
-- When a drift check last ran; claimed with a conditional update so only one runs at a time.
ALTER TABLE sync_state ADD COLUMN last_checked_at INTEGER;
-- Short reason the last background sync failed (never note content); NULL after a success.
ALTER TABLE sync_state ADD COLUMN last_sync_error TEXT;

-- X-GitHub-Delivery ids we have processed, for dedupe. Pruned after 7 days.
CREATE TABLE webhook_deliveries (
  space_id     TEXT NOT NULL,
  delivery_id  TEXT NOT NULL,
  event        TEXT NOT NULL,
  received_at  INTEGER NOT NULL,
  PRIMARY KEY (space_id, delivery_id)
);
CREATE INDEX webhook_deliveries_received ON webhook_deliveries(space_id, received_at);
