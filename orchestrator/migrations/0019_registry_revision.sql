CREATE TABLE registry_state (id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1), revision bigint NOT NULL DEFAULT 0);
INSERT INTO registry_state VALUES (1, 0);
ALTER TABLE registry_outbox ADD COLUMN revision bigint;
WITH ordered AS (SELECT id, row_number() OVER (ORDER BY created_at, id) AS revision FROM registry_outbox)
UPDATE registry_outbox o SET revision = ordered.revision FROM ordered WHERE o.id = ordered.id;
UPDATE registry_state SET revision = COALESCE((SELECT max(revision) FROM registry_outbox), 0);
ALTER TABLE registry_outbox ALTER COLUMN revision SET NOT NULL;
ALTER TABLE registry_outbox ADD CONSTRAINT registry_outbox_revision_unique UNIQUE (revision);
