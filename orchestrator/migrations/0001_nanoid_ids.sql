-- Internal identifiers are Nano IDs. Player IDs remain Minecraft UUIDs.
ALTER TABLE "game_sessions"
  DROP CONSTRAINT IF EXISTS "game_sessions_instance_fk";
ALTER TABLE "server_instances"
  DROP CONSTRAINT IF EXISTS "server_instances_session_id_fkey";
ALTER TABLE "queue_entry_players"
  DROP CONSTRAINT IF EXISTS "queue_entry_players_queue_entry_id_fkey";
ALTER TABLE "session_players"
  DROP CONSTRAINT IF EXISTS "session_players_session_id_fkey";
ALTER TABLE "instance_players"
  DROP CONSTRAINT IF EXISTS "instance_players_instance_id_fkey";
ALTER TABLE "commands"
  DROP CONSTRAINT IF EXISTS "commands_instance_id_fkey";

ALTER TABLE "game_sessions"
  ALTER COLUMN "id" TYPE text USING "id"::text,
  ALTER COLUMN "instance_id" TYPE text USING "instance_id"::text;
ALTER TABLE "server_instances"
  ALTER COLUMN "id" TYPE text USING "id"::text,
  ALTER COLUMN "session_id" TYPE text USING "session_id"::text;
ALTER TABLE "queue_entries"
  ALTER COLUMN "id" TYPE text USING "id"::text;
ALTER TABLE "queue_entry_players"
  ALTER COLUMN "queue_entry_id" TYPE text USING "queue_entry_id"::text;
ALTER TABLE "session_players"
  ALTER COLUMN "session_id" TYPE text USING "session_id"::text;
ALTER TABLE "instance_players"
  ALTER COLUMN "instance_id" TYPE text USING "instance_id"::text;
ALTER TABLE "commands"
  ALTER COLUMN "id" TYPE text USING "id"::text,
  ALTER COLUMN "instance_id" TYPE text USING "instance_id"::text;
ALTER TABLE "events"
  ALTER COLUMN "id" TYPE text USING "id"::text;

ALTER TABLE "game_sessions"
  ADD CONSTRAINT "game_sessions_instance_fk"
  FOREIGN KEY ("instance_id") REFERENCES "server_instances"("id");
ALTER TABLE "server_instances"
  ADD CONSTRAINT "server_instances_session_id_fkey"
  FOREIGN KEY ("session_id") REFERENCES "game_sessions"("id");
ALTER TABLE "queue_entry_players"
  ADD CONSTRAINT "queue_entry_players_queue_entry_id_fkey"
  FOREIGN KEY ("queue_entry_id") REFERENCES "queue_entries"("id") ON DELETE CASCADE;
ALTER TABLE "session_players"
  ADD CONSTRAINT "session_players_session_id_fkey"
  FOREIGN KEY ("session_id") REFERENCES "game_sessions"("id") ON DELETE CASCADE;
ALTER TABLE "instance_players"
  ADD CONSTRAINT "instance_players_instance_id_fkey"
  FOREIGN KEY ("instance_id") REFERENCES "server_instances"("id") ON DELETE CASCADE;
ALTER TABLE "commands"
  ADD CONSTRAINT "commands_instance_id_fkey"
  FOREIGN KEY ("instance_id") REFERENCES "server_instances"("id");
