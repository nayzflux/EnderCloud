ALTER TABLE "game_sessions"
  ADD COLUMN "transfer_started_at" timestamptz;

ALTER TABLE "session_players"
  ADD COLUMN "transferring_at" timestamptz;

UPDATE "session_players"
SET "transferring_at" = "selected_at"
WHERE "state" = 'TRANSFERRING';

ALTER TABLE "server_instances"
  ADD COLUMN "starting_at" timestamptz;

UPDATE "server_instances"
SET "starting_at" = COALESCE("updated_at", "created_at")
WHERE "lifecycle_state" = 'STARTING';

CREATE TABLE "transfer_commands" (
  "id" text PRIMARY KEY,
  "instance_id" text NOT NULL REFERENCES "server_instances"("id") ON DELETE CASCADE,
  "session_id" text REFERENCES "game_sessions"("id") ON DELETE CASCADE,
  "payload" jsonb NOT NULL,
  "state" text NOT NULL DEFAULT 'PENDING',
  "attempts" integer NOT NULL DEFAULT 0,
  "next_attempt_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "completed_at" timestamptz,
  CONSTRAINT "transfer_commands_state_check"
    CHECK ("state" IN ('PENDING', 'COMPLETED', 'EXPIRED', 'CANCELLED'))
);

CREATE INDEX "transfer_commands_due_idx"
  ON "transfer_commands" ("state", "next_attempt_at")
  WHERE "state" = 'PENDING';

CREATE INDEX "transfer_commands_session_idx"
  ON "transfer_commands" ("session_id");
