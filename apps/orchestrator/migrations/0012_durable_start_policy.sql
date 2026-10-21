CREATE TYPE "public"."variant_start_state" AS ENUM('BACKING_OFF', 'PROBING', 'BLOCKED', 'RESETTING');
ALTER TYPE "command_state" ADD VALUE IF NOT EXISTS 'CANCELLED';

ALTER TABLE "server_instances" ADD COLUMN "variant_revision" integer;
ALTER TABLE "server_instances" ADD COLUMN "failed_at" timestamp with time zone;
ALTER TABLE "server_instances" ADD COLUMN "failure_reason" text;
ALTER TABLE "server_instances" ADD COLUMN "failure_details" jsonb;
ALTER TABLE "server_instances" ADD COLUMN "failure_log_tail" text;
ALTER TABLE "server_instances" ADD COLUMN "runtime_retained" boolean DEFAULT false NOT NULL;
UPDATE "server_instances" AS instance
SET "variant_revision" = variant."revision"
FROM "server_variants" AS variant
WHERE variant."id" = instance."variant_id";
ALTER TABLE "server_instances" ALTER COLUMN "variant_revision" SET NOT NULL;
ALTER TABLE "server_instances" ALTER COLUMN "variant_revision" SET DEFAULT 1;

ALTER TABLE "commands" ADD COLUMN "started_at" timestamp with time zone;
UPDATE "commands" SET "state" = 'PENDING', "started_at" = NULL
WHERE "operation" = 'CREATE' AND "state" = 'RUNNING';

CREATE TABLE "variant_start_states" (
  "group_id" text NOT NULL,
  "variant_id" text NOT NULL,
  "variant_revision" integer NOT NULL,
  "state" "variant_start_state" NOT NULL,
  "failure_count" integer DEFAULT 0 NOT NULL,
  "next_retry_at" timestamp with time zone,
  "probe_instance_id" text,
  "last_failed_instance_id" text,
  "last_failure_reason" text,
  "last_failure_at" timestamp with time zone,
  "reset_requested_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "variant_start_states_group_id_variant_id_variant_revision_pk"
    PRIMARY KEY("group_id", "variant_id", "variant_revision"),
  CONSTRAINT "variant_start_states_failure_count_check" CHECK ("failure_count" >= 0)
);
ALTER TABLE "variant_start_states" ADD CONSTRAINT "variant_start_states_group_id_server_groups_id_fk"
  FOREIGN KEY ("group_id") REFERENCES "public"."server_groups"("id") ON DELETE cascade;
ALTER TABLE "variant_start_states" ADD CONSTRAINT "variant_start_states_variant_id_server_variants_id_fk"
  FOREIGN KEY ("variant_id") REFERENCES "public"."server_variants"("id") ON DELETE cascade;
ALTER TABLE "variant_start_states" ADD CONSTRAINT "variant_start_states_probe_instance_id_server_instances_id_fk"
  FOREIGN KEY ("probe_instance_id") REFERENCES "public"."server_instances"("id") ON DELETE set null;
ALTER TABLE "variant_start_states" ADD CONSTRAINT "variant_start_states_last_failed_instance_id_server_instances_id_fk"
  FOREIGN KEY ("last_failed_instance_id") REFERENCES "public"."server_instances"("id") ON DELETE set null;
CREATE INDEX "variant_start_states_due_idx" ON "variant_start_states" USING btree ("state", "next_retry_at");

ALTER TABLE "game_sessions" DROP COLUMN "retry_count";

DELETE FROM "operational_incidents" WHERE "kind" = 'SESSION_RETRIES_EXHAUSTED';
ALTER TYPE "incident_kind" RENAME TO "incident_kind_legacy";
CREATE TYPE "incident_kind" AS ENUM (
  'CAPACITY_BLOCKED',
  'INSTANCE_FAILURE_LOOP',
  'HOST_UNAVAILABLE',
  'HOST_RECOVERY_STUCK',
  'HOST_MAINTENANCE_BLOCKED',
  'TRANSFER_FAILURE_LOOP',
  'COMMAND_FAILURE_LOOP',
  'CONTROL_LOOP_FAILURE'
);
ALTER TABLE "operational_incidents" ALTER COLUMN "kind" TYPE "incident_kind"
  USING "kind"::text::"incident_kind";
DROP TYPE "incident_kind_legacy";
