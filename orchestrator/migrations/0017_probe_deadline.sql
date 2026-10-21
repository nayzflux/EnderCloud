ALTER TABLE variant_start_states ADD COLUMN probe_deadline timestamptz;
UPDATE variant_start_states SET probe_deadline = now() WHERE state = 'PROBING';
