ALTER TABLE "server_groups"
  ADD COLUMN "instance_lifetime_ms" integer;

UPDATE "server_groups"
SET "instance_lifetime_ms" = 14400000
WHERE "type" = 'hub';

ALTER TABLE "server_groups"
  ADD CONSTRAINT "server_groups_instance_lifetime_check"
  CHECK ("instance_lifetime_ms" IS NULL OR "instance_lifetime_ms" > 0);

ALTER TABLE "server_instances"
  ADD COLUMN "renewal_deadline" timestamptz,
  ADD COLUMN "replaces_instance_id" text
    REFERENCES "server_instances" ("id");

CREATE UNIQUE INDEX "server_instances_active_replacement_unique"
  ON "server_instances" ("replaces_instance_id")
  WHERE "replaces_instance_id" IS NOT NULL
    AND "lifecycle_state" IN ('CREATING', 'STARTING', 'RUNNING');
