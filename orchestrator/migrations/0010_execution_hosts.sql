CREATE TYPE "execution_host_health" AS ENUM ('RECOVERING', 'ONLINE', 'OFFLINE');
CREATE TYPE "execution_host_admin_state" AS ENUM ('ACTIVE', 'DRAINING', 'MAINTENANCE');

CREATE TABLE "execution_hosts" (
  "id" text PRIMARY KEY NOT NULL,
  "control_url" text NOT NULL,
  "game_address" text NOT NULL,
  "allocatable_cpu" double precision NOT NULL,
  "allocatable_memory_bytes" bigint NOT NULL,
  "health_state" "execution_host_health" DEFAULT 'RECOVERING' NOT NULL,
  "admin_state" "execution_host_admin_state" DEFAULT 'ACTIVE' NOT NULL,
  "agent_version" text NOT NULL,
  "last_heartbeat_at" timestamptz NOT NULL,
  "last_control_contact_at" timestamptz,
  "last_error" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "execution_hosts_cpu_check" CHECK ("allocatable_cpu" > 0),
  CONSTRAINT "execution_hosts_memory_check" CHECK ("allocatable_memory_bytes" > 0)
);

ALTER TABLE "server_instances" ADD COLUMN "host_id" text;
ALTER TABLE "server_instances" ADD COLUMN "reserved_cpu" double precision;
ALTER TABLE "server_instances" ADD COLUMN "reserved_memory_bytes" bigint;
ALTER TABLE "server_instances" ADD COLUMN "replacement_reason" text;
ALTER TABLE "server_instances" ADD CONSTRAINT "server_instances_host_id_execution_hosts_id_fk"
  FOREIGN KEY ("host_id") REFERENCES "execution_hosts"("id");
ALTER TABLE "server_instances" ADD CONSTRAINT "server_instances_host_reservation_check" CHECK (
  ("host_id" IS NULL AND "reserved_cpu" IS NULL AND "reserved_memory_bytes" IS NULL)
  OR
  ("host_id" IS NOT NULL AND "reserved_cpu" > 0 AND "reserved_memory_bytes" > 0)
);

CREATE INDEX "execution_hosts_health_admin_idx"
  ON "execution_hosts" ("health_state", "admin_state");
CREATE INDEX "server_instances_host_state_idx"
  ON "server_instances" ("host_id", "lifecycle_state");

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "server_instances"
    WHERE "lifecycle_state" <> 'STOPPED'
  ) THEN
    RAISE EXCEPTION 'Stop every active instance before applying the multi-host migration';
  END IF;
END $$;
