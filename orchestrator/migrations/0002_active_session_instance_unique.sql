-- A session may keep several historical instance attempts, but only one attempt
-- may be active at a time. FAILED/STOPPING/STOPPED attempts no longer block a retry.
DROP INDEX IF EXISTS "server_instances_session_unique";

CREATE UNIQUE INDEX "server_instances_session_unique"
  ON "server_instances" ("session_id")
  WHERE "session_id" IS NOT NULL
    AND "lifecycle_state" IN ('CREATING', 'STARTING', 'RUNNING', 'DRAINING');
