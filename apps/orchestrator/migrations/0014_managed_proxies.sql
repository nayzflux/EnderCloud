ALTER TYPE group_type ADD VALUE IF NOT EXISTS 'proxy';
--> statement-breakpoint
ALTER TABLE execution_hosts ADD COLUMN proxy_address text;
ALTER TABLE execution_hosts ADD COLUMN proxy_port_start integer;
ALTER TABLE execution_hosts ADD COLUMN proxy_port_end integer;
ALTER TABLE execution_hosts ADD CONSTRAINT execution_hosts_proxy_ports_check CHECK (
  (proxy_address IS NULL AND proxy_port_start IS NULL AND proxy_port_end IS NULL)
  OR (proxy_address IS NOT NULL AND proxy_port_start IS NOT NULL AND proxy_port_end IS NOT NULL
      AND proxy_port_start BETWEEN 1 AND 65535 AND proxy_port_end BETWEEN proxy_port_start AND 65535)
);
--> statement-breakpoint
ALTER TABLE proxy_heartbeats ADD COLUMN ready boolean NOT NULL DEFAULT false;
ALTER TABLE proxy_heartbeats ADD COLUMN accepting_connections boolean NOT NULL DEFAULT false;
