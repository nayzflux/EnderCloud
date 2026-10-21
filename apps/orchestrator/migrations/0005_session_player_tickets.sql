ALTER TABLE "session_players"
  ADD COLUMN "queue_entry_id" text REFERENCES "queue_entries"("id") ON DELETE SET NULL;

-- Existing rows predate explicit ticket identity. Link each one to the most
-- recent matching queue entry when it can be reconstructed.
UPDATE "session_players" sp
SET "queue_entry_id" = (
  SELECT q.id
  FROM "queue_entries" q
  WHERE q.session_id = sp.session_id
    AND q.party_id = sp.party_id
  ORDER BY q.transfer_started_at DESC NULLS LAST, q.joined_at DESC, q.id DESC
  LIMIT 1
);

CREATE INDEX "session_players_queue_entry_idx"
  ON "session_players" ("queue_entry_id");
