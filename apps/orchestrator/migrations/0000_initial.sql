CREATE TYPE "group_type" AS ENUM ('hub', 'minigame');
CREATE TYPE "lifecycle_state" AS ENUM ('CREATING', 'STARTING', 'RUNNING', 'DRAINING', 'STOPPING', 'STOPPED', 'FAILED', 'ORPHANED');
CREATE TYPE "availability_state" AS ENUM ('OPEN', 'RESERVED');
CREATE TYPE "session_state" AS ENUM ('FORMING', 'WAITING_FOR_INSTANCE', 'TRANSFERRING', 'WAITING', 'STARTING', 'RUNNING', 'FINISHED', 'CANCELLED', 'FAILED');
CREATE TYPE "session_player_state" AS ENUM ('SELECTED', 'TRANSFERRING', 'CONNECTED', 'LEFT');
CREATE TYPE "queue_entry_state" AS ENUM ('QUEUED', 'SELECTED', 'LEFT');
CREATE TYPE "command_state" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED');

CREATE TABLE "server_groups" (
  "id" text PRIMARY KEY,
  "type" group_type NOT NULL,
  "enabled" boolean NOT NULL DEFAULT true,
  "minimum_players" integer,
  "maximum_players" integer,
  "team_count" integer,
  "team_size" integer,
  "waiting_timeout_ms" integer,
  "minimum_instances" integer NOT NULL DEFAULT 0,
  "maximum_instances" integer NOT NULL,
  "minimum_warm_instances" integer NOT NULL DEFAULT 0,
  "maximum_warm_instances" integer NOT NULL,
  "maximum_players_per_instance" integer,
  "target_players_per_instance" integer,
  "startup_timeout_ms" integer NOT NULL,
  "draining_timeout_ms" integer NOT NULL,
  "shutdown_timeout_ms" integer NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "server_groups_capacity_check" CHECK ("maximum_instances" >= "minimum_instances"),
  CONSTRAINT "server_groups_warm_capacity_check" CHECK ("maximum_warm_instances" >= "minimum_warm_instances")
);

CREATE TABLE "server_variants" (
  "id" text PRIMARY KEY,
  "group_id" text NOT NULL REFERENCES "server_groups"("id"),
  "template_path" text NOT NULL,
  "enabled" boolean NOT NULL DEFAULT true,
  "revision" integer NOT NULL,
  "selection_weight" integer NOT NULL,
  "checksum" text NOT NULL,
  "runtime_spec" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "server_variants_weight_check" CHECK ("selection_weight" > 0)
);
CREATE INDEX "server_variants_group_idx" ON "server_variants" ("group_id");

CREATE TABLE "game_sessions" (
  "id" uuid PRIMARY KEY,
  "group_id" text NOT NULL REFERENCES "server_groups"("id"),
  "instance_id" uuid,
  "state" session_state NOT NULL,
  "assignment_revision" integer NOT NULL DEFAULT 1,
  "assignment_acknowledged_at" timestamptz,
  "waiting_deadline" timestamptz NOT NULL,
  "retry_count" integer NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "started_at" timestamptz,
  "finished_at" timestamptz,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "game_sessions_group_state_idx" ON "game_sessions" ("group_id", "state");
CREATE INDEX "game_sessions_instance_idx" ON "game_sessions" ("instance_id");

CREATE TABLE "server_instances" (
  "id" uuid PRIMARY KEY,
  "group_id" text NOT NULL REFERENCES "server_groups"("id"),
  "variant_id" text NOT NULL REFERENCES "server_variants"("id"),
  "session_id" uuid REFERENCES "game_sessions"("id"),
  "lifecycle_state" lifecycle_state NOT NULL,
  "availability_state" availability_state NOT NULL,
  "container_id" text,
  "runtime_path" text,
  "endpoint" text,
  "player_count" integer NOT NULL DEFAULT 0,
  "drain_deadline" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "running_at" timestamptz,
  "draining_at" timestamptz,
  "stopped_at" timestamptz,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "server_instances_reserved_session_check" CHECK ("availability_state" <> 'RESERVED' OR "session_id" IS NOT NULL)
);
CREATE INDEX "server_instances_group_state_idx" ON "server_instances" ("group_id", "lifecycle_state", "availability_state");
CREATE UNIQUE INDEX "server_instances_session_unique" ON "server_instances" ("session_id") WHERE "session_id" IS NOT NULL;
ALTER TABLE "game_sessions" ADD CONSTRAINT "game_sessions_instance_fk" FOREIGN KEY ("instance_id") REFERENCES "server_instances"("id");

CREATE TABLE "queue_entries" (
  "id" uuid PRIMARY KEY,
  "group_id" text NOT NULL REFERENCES "server_groups"("id"),
  "party_id" text NOT NULL,
  "state" queue_entry_state NOT NULL DEFAULT 'QUEUED',
  "joined_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "queue_entries_matchmaking_idx" ON "queue_entries" ("group_id", "state", "joined_at");
CREATE UNIQUE INDEX "queue_entries_active_party_unique" ON "queue_entries" ("group_id", "party_id") WHERE "state" = 'QUEUED';

CREATE TABLE "queue_entry_players" (
  "queue_entry_id" uuid NOT NULL REFERENCES "queue_entries"("id") ON DELETE CASCADE,
  "player_id" uuid NOT NULL,
  PRIMARY KEY ("queue_entry_id", "player_id")
);
CREATE INDEX "queue_entry_players_player_idx" ON "queue_entry_players" ("player_id");

CREATE TABLE "session_players" (
  "session_id" uuid NOT NULL REFERENCES "game_sessions"("id") ON DELETE CASCADE,
  "player_id" uuid NOT NULL,
  "party_id" text NOT NULL,
  "team_index" integer NOT NULL,
  "state" session_player_state NOT NULL DEFAULT 'SELECTED',
  "selected_at" timestamptz NOT NULL DEFAULT now(),
  "connected_at" timestamptz,
  "left_at" timestamptz,
  PRIMARY KEY ("session_id", "player_id")
);
CREATE INDEX "session_players_player_idx" ON "session_players" ("player_id");

CREATE TABLE "instance_players" (
  "instance_id" uuid NOT NULL REFERENCES "server_instances"("id") ON DELETE CASCADE,
  "player_id" uuid NOT NULL,
  "connected_at" timestamptz NOT NULL DEFAULT now(),
  "last_seen_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("instance_id", "player_id")
);
CREATE INDEX "instance_players_player_idx" ON "instance_players" ("player_id");

CREATE TABLE "commands" (
  "id" uuid PRIMARY KEY,
  "instance_id" uuid REFERENCES "server_instances"("id"),
  "operation" text NOT NULL,
  "state" command_state NOT NULL DEFAULT 'PENDING',
  "attempts" integer NOT NULL DEFAULT 0,
  "payload" jsonb,
  "last_error" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "completed_at" timestamptz
);
CREATE INDEX "commands_pending_idx" ON "commands" ("state", "created_at");

CREATE TABLE "nodes" (
  "id" text PRIMARY KEY,
  "kind" text NOT NULL DEFAULT 'LOCAL_DOCKER',
  "enabled" boolean NOT NULL DEFAULT true,
  "last_seen_at" timestamptz NOT NULL DEFAULT now(),
  "metadata" jsonb
);

CREATE TABLE "events" (
  "id" uuid PRIMARY KEY,
  "aggregate_type" text NOT NULL,
  "aggregate_id" text NOT NULL,
  "type" text NOT NULL,
  "payload" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "events_aggregate_idx" ON "events" ("aggregate_type", "aggregate_id", "created_at");

CREATE TABLE "proxy_heartbeats" (
  "proxy_id" text PRIMARY KEY,
  "player_count" integer NOT NULL DEFAULT 0,
  "last_seen_at" timestamptz NOT NULL DEFAULT now()
);
