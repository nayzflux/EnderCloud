CREATE TABLE registry_outbox (
  id text PRIMARY KEY,
  type text NOT NULL CHECK (type IN ('SERVER_REGISTERED', 'SERVER_UPDATED', 'SERVER_UNREGISTERED')),
  payload jsonb NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);
CREATE INDEX registry_outbox_pending_idx ON registry_outbox(next_attempt_at) WHERE published_at IS NULL;
