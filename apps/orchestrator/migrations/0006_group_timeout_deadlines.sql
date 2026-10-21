ALTER TABLE "server_groups"
  RENAME COLUMN "instance_wait_timeout_ms" TO "instance_acquisition_timeout_ms";
ALTER TABLE "server_groups"
  RENAME COLUMN "maximum_waiting_timeout_ms" TO "lobby_stale_timeout_ms";
ALTER TABLE "server_groups"
  RENAME COLUMN "draining_timeout_ms" TO "drain_timeout_ms";
ALTER TABLE "server_groups"
  DROP CONSTRAINT "server_groups_matchmaking_policy_check",
  DROP COLUMN "waiting_timeout_ms";
ALTER TABLE "server_groups"
  ADD CONSTRAINT "server_groups_matchmaking_policy_check" CHECK (
    "type" <> 'minigame' OR (
      "candidate_window" > 0
      AND "minimum_players_per_team" BETWEEN 0 AND "team_size"
      AND "maximum_team_spread" BETWEEN 0 AND "team_size"
    )
  );

ALTER TABLE "server_groups"
  ADD COLUMN "cancelled_drain_timeout_ms" integer NOT NULL DEFAULT 10000,
  ADD COLUMN "transfer_timeout_ms" integer NOT NULL DEFAULT 20000,
  ADD COLUMN "player_stale_timeout_ms" integer NOT NULL DEFAULT 30000;

ALTER TABLE "game_sessions"
  ADD COLUMN "instance_acquisition_deadline" timestamptz,
  ADD COLUMN "lobby_stale_deadline" timestamptz;

UPDATE "game_sessions"
SET
  "instance_acquisition_deadline" = CASE
    WHEN "state" = 'WAITING_FOR_INSTANCE' THEN "waiting_deadline"
    ELSE NULL
  END,
  "lobby_stale_deadline" = "maximum_waiting_deadline";

ALTER TABLE "game_sessions"
  DROP COLUMN "waiting_deadline",
  DROP COLUMN "maximum_waiting_deadline";

ALTER TABLE "server_instances"
  ADD COLUMN "startup_deadline" timestamptz,
  ADD COLUMN "drain_reason" text,
  ADD COLUMN "stopping_at" timestamptz,
  ADD COLUMN "shutdown_deadline" timestamptz;

UPDATE "server_instances" AS i
SET "startup_deadline" =
  COALESCE(i."starting_at", i."updated_at")
  + (g."startup_timeout_ms" * interval '1 millisecond')
FROM "server_groups" AS g
WHERE i."group_id" = g."id"
  AND i."lifecycle_state" = 'STARTING';

UPDATE "server_instances" AS i
SET "drain_reason" = CASE
  WHEN s."state" = 'CANCELLED' THEN 'SESSION_CANCELLED'
  ELSE 'NORMAL'
END
FROM "game_sessions" AS s
WHERE i."session_id" = s."id"
  AND i."lifecycle_state" = 'DRAINING';

UPDATE "server_instances"
SET "drain_reason" = 'NORMAL'
WHERE "lifecycle_state" = 'DRAINING'
  AND "drain_reason" IS NULL;

UPDATE "server_instances" AS i
SET
  "stopping_at" = i."updated_at",
  "shutdown_deadline" =
    i."updated_at" + (g."shutdown_timeout_ms" * interval '1 millisecond')
FROM "server_groups" AS g
WHERE i."group_id" = g."id"
  AND i."lifecycle_state" = 'STOPPING';

ALTER TABLE "session_players"
  ADD COLUMN "transfer_deadline" timestamptz;

UPDATE "session_players" AS sp
SET "transfer_deadline" = COALESCE(
  (
    SELECT min(tc."expires_at")
    FROM "transfer_commands" AS tc
    WHERE tc."session_id" = sp."session_id"
      AND tc."state" = 'PENDING'
  ),
  sp."transferring_at" + (g."transfer_timeout_ms" * interval '1 millisecond')
)
FROM "game_sessions" AS s
JOIN "server_groups" AS g ON g."id" = s."group_id"
WHERE sp."session_id" = s."id"
  AND sp."state" = 'TRANSFERRING'
  AND sp."transferring_at" IS NOT NULL;

ALTER TABLE "instance_players"
  ADD COLUMN "stale_deadline" timestamptz;

UPDATE "instance_players" AS ip
SET "stale_deadline" =
  ip."last_seen_at" + (g."player_stale_timeout_ms" * interval '1 millisecond')
FROM "server_instances" AS i
JOIN "server_groups" AS g ON g."id" = i."group_id"
WHERE ip."instance_id" = i."id";

ALTER TABLE "instance_players"
  ALTER COLUMN "stale_deadline" SET NOT NULL;

ALTER TABLE "server_groups"
  ALTER COLUMN "cancelled_drain_timeout_ms" DROP DEFAULT,
  ALTER COLUMN "transfer_timeout_ms" DROP DEFAULT,
  ALTER COLUMN "player_stale_timeout_ms" DROP DEFAULT;
