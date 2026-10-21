CREATE TABLE "transfer_command_players" (
  "command_id" text NOT NULL,
  "player_id" uuid NOT NULL,
  "state" text DEFAULT 'PENDING' NOT NULL,
  "observed_at" timestamp with time zone,
  CONSTRAINT "transfer_command_players_command_id_player_id_pk" PRIMARY KEY("command_id", "player_id"),
  CONSTRAINT "transfer_command_players_state_check" CHECK ("state" IN ('PENDING', 'ARRIVED', 'LEFT'))
);
ALTER TABLE "transfer_command_players" ADD CONSTRAINT "transfer_command_players_command_id_transfer_commands_id_fk"
  FOREIGN KEY ("command_id") REFERENCES "public"."transfer_commands"("id") ON DELETE cascade;
CREATE INDEX "transfer_command_players_pending_idx" ON "transfer_command_players" USING btree ("state", "player_id");

INSERT INTO "transfer_command_players" ("command_id", "player_id", "state", "observed_at")
SELECT DISTINCT command."id", expected.player_id::uuid,
  CASE
    WHEN EXISTS (
      SELECT 1 FROM instance_players present
      WHERE present.instance_id = command.instance_id AND present.player_id = expected.player_id::uuid
    ) THEN 'ARRIVED'
    WHEN command.session_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM session_players member
      WHERE member.session_id = command.session_id
        AND member.player_id = expected.player_id::uuid AND member.state = 'LEFT'
    ) THEN 'LEFT'
    ELSE 'PENDING'
  END,
  CASE
    WHEN EXISTS (
      SELECT 1 FROM instance_players present
      WHERE present.instance_id = command.instance_id AND present.player_id = expected.player_id::uuid
    ) THEN now()
    ELSE NULL
  END
FROM transfer_commands command
CROSS JOIN LATERAL jsonb_array_elements_text(command.payload->'players') expected(player_id)
ON CONFLICT ("command_id", "player_id") DO NOTHING;
