ALTER TABLE "server_groups"
  ADD COLUMN "candidate_window" integer,
  ADD COLUMN "instance_wait_timeout_ms" integer,
  ADD COLUMN "maximum_waiting_timeout_ms" integer,
  ADD COLUMN "minimum_players_per_team" integer,
  ADD COLUMN "maximum_team_spread" integer;

UPDATE "server_groups"
SET
  "candidate_window" = 20,
  "instance_wait_timeout_ms" = "waiting_timeout_ms",
  "maximum_waiting_timeout_ms" = "waiting_timeout_ms" * 3,
  "minimum_players_per_team" = 0,
  "maximum_team_spread" = "team_size"
WHERE "type" = 'minigame';

ALTER TABLE "server_groups"
  ADD CONSTRAINT "server_groups_matchmaking_policy_check"
  CHECK (
    "type" <> 'minigame' OR (
      "candidate_window" > 0
      AND "maximum_waiting_timeout_ms" >= "waiting_timeout_ms"
      AND "minimum_players_per_team" BETWEEN 0 AND "team_size"
      AND "maximum_team_spread" BETWEEN 0 AND "team_size"
    )
  );

ALTER TABLE "game_sessions"
  ALTER COLUMN "waiting_deadline" DROP NOT NULL,
  ADD COLUMN "maximum_waiting_deadline" timestamptz;

UPDATE "game_sessions" gs
SET "maximum_waiting_deadline" =
  gs."waiting_deadline" + (g."waiting_timeout_ms" * 2 * interval '1 millisecond')
FROM "server_groups" g
WHERE g.id = gs.group_id
  AND gs.state IN ('TRANSFERRING', 'WAITING')
  AND gs."waiting_deadline" IS NOT NULL;

ALTER TABLE "queue_entries"
  ADD COLUMN "session_id" text REFERENCES "game_sessions"("id") ON DELETE SET NULL,
  ADD COLUMN "transfer_started_at" timestamptz;

CREATE INDEX "queue_entries_session_idx" ON "queue_entries" ("session_id");

-- Recover unambiguous active links created by earlier orchestrator versions.
UPDATE "queue_entries" q
SET "session_id" = candidate.session_id
FROM (
  SELECT q2.id AS queue_id, min(sp.session_id) AS session_id
  FROM "queue_entries" q2
  JOIN "session_players" sp ON sp.party_id = q2.party_id AND sp.state <> 'LEFT'
  JOIN "game_sessions" gs ON gs.id = sp.session_id AND gs.group_id = q2.group_id
  WHERE q2.state = 'SELECTED'
    AND gs.state NOT IN ('FINISHED', 'CANCELLED', 'FAILED')
  GROUP BY q2.id
  HAVING count(DISTINCT sp.session_id) = 1
) candidate
WHERE q.id = candidate.queue_id;

UPDATE "queue_entries" q
SET "transfer_started_at" = gs.transfer_started_at
FROM "game_sessions" gs
WHERE q.session_id = gs.id
  AND gs.transfer_started_at IS NOT NULL;

ALTER TABLE "session_players" DROP COLUMN "team_index";
