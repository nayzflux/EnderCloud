ALTER TABLE server_instances ADD COLUMN paper_health_deadline timestamptz DEFAULT (now() + interval '30 seconds');
ALTER TABLE server_instances ADD COLUMN health_suspected_at timestamptz;
