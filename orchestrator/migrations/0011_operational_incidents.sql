CREATE TYPE "incident_kind" AS ENUM (
  'CAPACITY_BLOCKED',
  'INSTANCE_FAILURE_LOOP',
  'HOST_UNAVAILABLE',
  'HOST_RECOVERY_STUCK',
  'HOST_MAINTENANCE_BLOCKED',
  'SESSION_RETRIES_EXHAUSTED',
  'TRANSFER_FAILURE_LOOP',
  'COMMAND_FAILURE_LOOP',
  'CONTROL_LOOP_FAILURE'
);
CREATE TYPE "incident_severity" AS ENUM ('WARNING', 'CRITICAL');
CREATE TYPE "incident_state" AS ENUM ('PENDING', 'ACTIVE', 'RESOLVED');
CREATE TYPE "incident_scope_type" AS ENUM ('CLUSTER', 'HOST', 'GROUP', 'VARIANT', 'SESSION');

CREATE TABLE "operational_incidents" (
  "id" text PRIMARY KEY NOT NULL,
  "fingerprint" text NOT NULL,
  "kind" "incident_kind" NOT NULL,
  "severity" "incident_severity" NOT NULL,
  "state" "incident_state" DEFAULT 'PENDING' NOT NULL,
  "scope_type" "incident_scope_type" NOT NULL,
  "scope_id" text NOT NULL,
  "group_id" text,
  "variant_id" text,
  "summary" text NOT NULL,
  "cause" text NOT NULL,
  "evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "occurrence_count" integer DEFAULT 1 NOT NULL,
  "first_observed_at" timestamptz DEFAULT now() NOT NULL,
  "last_observed_at" timestamptz DEFAULT now() NOT NULL,
  "opened_at" timestamptz,
  "resolved_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "operational_incidents_occurrence_check" CHECK ("occurrence_count" > 0)
);

CREATE UNIQUE INDEX "operational_incidents_unresolved_fingerprint_idx"
  ON "operational_incidents" ("fingerprint") WHERE "state" <> 'RESOLVED';
CREATE INDEX "operational_incidents_state_last_observed_idx"
  ON "operational_incidents" ("state", "last_observed_at");
CREATE INDEX "operational_incidents_group_state_idx"
  ON "operational_incidents" ("group_id", "state");
