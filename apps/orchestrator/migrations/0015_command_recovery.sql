ALTER TABLE commands ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now();
