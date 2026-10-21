CREATE TYPE "public"."availability_state" AS ENUM('OPEN', 'RESERVED');--> statement-breakpoint
CREATE TYPE "public"."command_state" AS ENUM('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."execution_host_admin_state" AS ENUM('ACTIVE', 'DRAINING', 'MAINTENANCE');--> statement-breakpoint
CREATE TYPE "public"."execution_host_health" AS ENUM('RECOVERING', 'ONLINE', 'OFFLINE');--> statement-breakpoint
CREATE TYPE "public"."group_type" AS ENUM('hub', 'minigame', 'proxy');--> statement-breakpoint
CREATE TYPE "public"."incident_kind" AS ENUM('CAPACITY_BLOCKED', 'INSTANCE_FAILURE_LOOP', 'HOST_UNAVAILABLE', 'HOST_RECOVERY_STUCK', 'HOST_MAINTENANCE_BLOCKED', 'TRANSFER_FAILURE_LOOP', 'COMMAND_FAILURE_LOOP', 'CONTROL_LOOP_FAILURE');--> statement-breakpoint
CREATE TYPE "public"."incident_scope_type" AS ENUM('CLUSTER', 'HOST', 'GROUP', 'VARIANT', 'SESSION');--> statement-breakpoint
CREATE TYPE "public"."incident_severity" AS ENUM('WARNING', 'CRITICAL');--> statement-breakpoint
CREATE TYPE "public"."incident_state" AS ENUM('PENDING', 'ACTIVE', 'RESOLVED');--> statement-breakpoint
CREATE TYPE "public"."lifecycle_state" AS ENUM('CREATING', 'STARTING', 'RUNNING', 'DRAINING', 'STOPPING', 'STOPPED', 'FAILED', 'ORPHANED');--> statement-breakpoint
CREATE TYPE "public"."queue_entry_state" AS ENUM('QUEUED', 'SELECTED', 'LEFT');--> statement-breakpoint
CREATE TYPE "public"."session_player_state" AS ENUM('SELECTED', 'TRANSFERRING', 'CONNECTED', 'LEFT');--> statement-breakpoint
CREATE TYPE "public"."session_state" AS ENUM('FORMING', 'WAITING_FOR_INSTANCE', 'TRANSFERRING', 'WAITING', 'STARTING', 'RUNNING', 'FINISHED', 'CANCELLED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."variant_start_state" AS ENUM('BACKING_OFF', 'PROBING', 'BLOCKED', 'RESETTING');--> statement-breakpoint
CREATE TABLE "commands" (
	"id" text PRIMARY KEY NOT NULL,
	"instance_id" text,
	"operation" text NOT NULL,
	"state" "command_state" DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payload" jsonb,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" text PRIMARY KEY NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "execution_hosts" (
	"id" text PRIMARY KEY NOT NULL,
	"control_url" text NOT NULL,
	"game_address" text NOT NULL,
	"proxy_address" text,
	"proxy_port_start" integer,
	"proxy_port_end" integer,
	"allocatable_cpu" double precision NOT NULL,
	"allocatable_memory_bytes" bigint NOT NULL,
	"health_state" "execution_host_health" DEFAULT 'RECOVERING' NOT NULL,
	"admin_state" "execution_host_admin_state" DEFAULT 'ACTIVE' NOT NULL,
	"agent_version" text NOT NULL,
	"last_heartbeat_at" timestamp with time zone NOT NULL,
	"last_control_contact_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "execution_hosts_cpu_check" CHECK ("execution_hosts"."allocatable_cpu" > 0),
	CONSTRAINT "execution_hosts_memory_check" CHECK ("execution_hosts"."allocatable_memory_bytes" > 0),
	CONSTRAINT "execution_hosts_proxy_ports_check" CHECK ((
      "execution_hosts"."proxy_address" IS NULL AND "execution_hosts"."proxy_port_start" IS NULL AND "execution_hosts"."proxy_port_end" IS NULL
    ) OR (
      "execution_hosts"."proxy_address" IS NOT NULL AND "execution_hosts"."proxy_port_start" IS NOT NULL AND "execution_hosts"."proxy_port_end" IS NOT NULL
      AND "execution_hosts"."proxy_port_start" BETWEEN 1 AND 65535 AND "execution_hosts"."proxy_port_end" BETWEEN "execution_hosts"."proxy_port_start" AND 65535
    ))
);
--> statement-breakpoint
CREATE TABLE "game_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"group_id" text NOT NULL,
	"instance_id" text,
	"state" "session_state" NOT NULL,
	"assignment_revision" integer DEFAULT 1 NOT NULL,
	"assignment_acknowledged_at" timestamp with time zone,
	"instance_acquisition_deadline" timestamp with time zone,
	"lobby_stale_deadline" timestamp with time zone,
	"transfer_started_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "instance_players" (
	"instance_id" text NOT NULL,
	"player_id" uuid NOT NULL,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stale_deadline" timestamp with time zone NOT NULL,
	CONSTRAINT "instance_players_instance_id_player_id_pk" PRIMARY KEY("instance_id","player_id")
);
--> statement-breakpoint
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
	"first_observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"opened_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operational_incidents_occurrence_check" CHECK ("operational_incidents"."occurrence_count" > 0)
);
--> statement-breakpoint
CREATE TABLE "player_transfer_generations" (
	"player_id" uuid PRIMARY KEY NOT NULL,
	"generation" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "proxy_heartbeats" (
	"proxy_id" text PRIMARY KEY NOT NULL,
	"ready" boolean DEFAULT false NOT NULL,
	"accepting_connections" boolean DEFAULT false NOT NULL,
	"player_count" integer DEFAULT 0 NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "queue_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"group_id" text NOT NULL,
	"party_id" text NOT NULL,
	"session_id" text,
	"state" "queue_entry_state" DEFAULT 'QUEUED' NOT NULL,
	"transfer_started_at" timestamp with time zone,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "queue_entry_players" (
	"queue_entry_id" text NOT NULL,
	"player_id" uuid NOT NULL,
	CONSTRAINT "queue_entry_players_queue_entry_id_player_id_pk" PRIMARY KEY("queue_entry_id","player_id")
);
--> statement-breakpoint
CREATE TABLE "registry_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"revision" bigint NOT NULL,
	"payload" jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	CONSTRAINT "registry_outbox_revision_unique" UNIQUE("revision")
);
--> statement-breakpoint
CREATE TABLE "registry_state" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"revision" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "release_metadata" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "server_group_variants" (
	"group_id" text NOT NULL,
	"variant_id" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"selection_weight" integer NOT NULL,
	CONSTRAINT "server_group_variants_group_id_variant_id_pk" PRIMARY KEY("group_id","variant_id"),
	CONSTRAINT "server_group_variants_weight_check" CHECK ("server_group_variants"."selection_weight" > 0)
);
--> statement-breakpoint
CREATE TABLE "server_groups" (
	"id" text PRIMARY KEY NOT NULL,
	"type" "group_type" NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"minimum_players" integer,
	"maximum_players" integer,
	"team_count" integer,
	"team_size" integer,
	"candidate_window" integer,
	"instance_acquisition_timeout_ms" integer,
	"lobby_stale_timeout_ms" integer,
	"minimum_players_per_team" integer,
	"maximum_team_spread" integer,
	"minimum_instances" integer DEFAULT 0 NOT NULL,
	"maximum_instances" integer NOT NULL,
	"minimum_warm_instances" integer DEFAULT 0 NOT NULL,
	"maximum_warm_instances" integer NOT NULL,
	"maximum_players_per_instance" integer,
	"target_players_per_instance" integer,
	"startup_timeout_ms" integer NOT NULL,
	"drain_timeout_ms" integer NOT NULL,
	"cancelled_drain_timeout_ms" integer NOT NULL,
	"shutdown_timeout_ms" integer NOT NULL,
	"transfer_timeout_ms" integer NOT NULL,
	"player_stale_timeout_ms" integer NOT NULL,
	"instance_lifetime_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "server_groups_capacity_check" CHECK ("server_groups"."maximum_instances" >= "server_groups"."minimum_instances"),
	CONSTRAINT "server_groups_warm_capacity_check" CHECK ("server_groups"."maximum_warm_instances" >= "server_groups"."minimum_warm_instances"),
	CONSTRAINT "server_groups_matchmaking_policy_check" CHECK ("server_groups"."type" <> 'minigame' OR (
        "server_groups"."candidate_window" > 0
        AND "server_groups"."minimum_players_per_team" BETWEEN 0 AND "server_groups"."team_size"
        AND "server_groups"."maximum_team_spread" BETWEEN 0 AND "server_groups"."team_size"
      )),
	CONSTRAINT "server_groups_instance_lifetime_check" CHECK ("server_groups"."instance_lifetime_ms" IS NULL OR "server_groups"."instance_lifetime_ms" > 0)
);
--> statement-breakpoint
CREATE TABLE "server_instances" (
	"id" text PRIMARY KEY NOT NULL,
	"group_id" text NOT NULL,
	"variant_id" text NOT NULL,
	"variant_revision" integer DEFAULT 1 NOT NULL,
	"session_id" text,
	"host_id" text,
	"reserved_cpu" double precision,
	"reserved_memory_bytes" bigint,
	"lifecycle_state" "lifecycle_state" NOT NULL,
	"availability_state" "availability_state" NOT NULL,
	"container_id" text,
	"runtime_path" text,
	"endpoint" text,
	"player_count" integer DEFAULT 0 NOT NULL,
	"paper_health_deadline" timestamp with time zone DEFAULT now() + interval '30 seconds',
	"health_suspected_at" timestamp with time zone,
	"startup_deadline" timestamp with time zone,
	"renewal_deadline" timestamp with time zone,
	"replaces_instance_id" text,
	"replacement_reason" text,
	"drain_deadline" timestamp with time zone,
	"drain_reason" text,
	"shutdown_deadline" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"failure_reason" text,
	"failure_details" jsonb,
	"failure_log_tail" text,
	"runtime_retained" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"starting_at" timestamp with time zone,
	"running_at" timestamp with time zone,
	"draining_at" timestamp with time zone,
	"stopping_at" timestamp with time zone,
	"stopped_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "server_instances_reserved_session_check" CHECK ("server_instances"."availability_state" <> 'RESERVED' OR "server_instances"."session_id" IS NOT NULL),
	CONSTRAINT "server_instances_host_reservation_check" CHECK ((
        "server_instances"."host_id" IS NULL
        AND "server_instances"."reserved_cpu" IS NULL
        AND "server_instances"."reserved_memory_bytes" IS NULL
      ) OR (
        "server_instances"."host_id" IS NOT NULL
        AND "server_instances"."reserved_cpu" > 0
        AND "server_instances"."reserved_memory_bytes" > 0
      ))
);
--> statement-breakpoint
CREATE TABLE "server_tps_metrics" (
	"group_id" text NOT NULL,
	"variant_id" text NOT NULL,
	"bucket_at" timestamp with time zone NOT NULL,
	"one_minute_sum" double precision NOT NULL,
	"five_minutes_sum" double precision NOT NULL,
	"fifteen_minutes_sum" double precision NOT NULL,
	"sample_count" integer NOT NULL,
	CONSTRAINT "server_tps_metrics_group_id_variant_id_bucket_at_pk" PRIMARY KEY("group_id","variant_id","bucket_at"),
	CONSTRAINT "server_tps_metrics_sample_count_check" CHECK ("server_tps_metrics"."sample_count" > 0)
);
--> statement-breakpoint
CREATE TABLE "server_variant_layers" (
	"variant_id" text NOT NULL,
	"layer_id" text NOT NULL,
	"ordinal" integer NOT NULL,
	CONSTRAINT "server_variant_layers_variant_id_ordinal_pk" PRIMARY KEY("variant_id","ordinal"),
	CONSTRAINT "server_variant_layers_ordinal_check" CHECK ("server_variant_layers"."ordinal" >= 0)
);
--> statement-breakpoint
CREATE TABLE "server_variants" (
	"id" text PRIMARY KEY NOT NULL,
	"revision" integer NOT NULL,
	"checksum" text NOT NULL,
	"runtime_spec" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"principal_id" text NOT NULL,
	"auth_key_id" text NOT NULL,
	"encrypted_secret" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_players" (
	"session_id" text NOT NULL,
	"player_id" uuid NOT NULL,
	"party_id" text NOT NULL,
	"queue_entry_id" text,
	"state" "session_player_state" DEFAULT 'SELECTED' NOT NULL,
	"selected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"transferring_at" timestamp with time zone,
	"transfer_deadline" timestamp with time zone,
	"connected_at" timestamp with time zone,
	"left_at" timestamp with time zone,
	CONSTRAINT "session_players_session_id_player_id_pk" PRIMARY KEY("session_id","player_id")
);
--> statement-breakpoint
CREATE TABLE "template_layers" (
	"id" text PRIMARY KEY NOT NULL,
	"template_path" text NOT NULL,
	"checksum" text NOT NULL,
	"runtime_patch" jsonb NOT NULL,
	"file_summary" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transfer_command_players" (
	"command_id" text NOT NULL,
	"player_id" uuid NOT NULL,
	"state" text DEFAULT 'PENDING' NOT NULL,
	"generation" bigint DEFAULT 1 NOT NULL,
	"observed_at" timestamp with time zone,
	CONSTRAINT "transfer_command_players_command_id_player_id_pk" PRIMARY KEY("command_id","player_id"),
	CONSTRAINT "transfer_command_players_state_check" CHECK ("transfer_command_players"."state" IN ('PENDING', 'ARRIVED', 'LEFT', 'SUPERSEDED', 'ABANDONED'))
);
--> statement-breakpoint
CREATE TABLE "transfer_commands" (
	"id" text PRIMARY KEY NOT NULL,
	"instance_id" text NOT NULL,
	"session_id" text,
	"payload" jsonb NOT NULL,
	"state" text DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "transfer_commands_state_check" CHECK ("transfer_commands"."state" IN ('PENDING', 'COMPLETED', 'EXPIRED', 'CANCELLED'))
);
--> statement-breakpoint
CREATE TABLE "variant_start_states" (
	"group_id" text NOT NULL,
	"variant_id" text NOT NULL,
	"variant_revision" integer NOT NULL,
	"state" "variant_start_state" NOT NULL,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"next_retry_at" timestamp with time zone,
	"probe_instance_id" text,
	"probe_deadline" timestamp with time zone,
	"last_failed_instance_id" text,
	"last_failure_reason" text,
	"last_failure_at" timestamp with time zone,
	"reset_requested_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "variant_start_states_group_id_variant_id_variant_revision_pk" PRIMARY KEY("group_id","variant_id","variant_revision"),
	CONSTRAINT "variant_start_states_failure_count_check" CHECK ("variant_start_states"."failure_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "apikey" (
	"id" text PRIMARY KEY NOT NULL,
	"config_id" text DEFAULT 'default' NOT NULL,
	"name" text,
	"start" text,
	"reference_id" text NOT NULL,
	"prefix" text,
	"key" text NOT NULL,
	"refill_interval" integer,
	"refill_amount" integer,
	"last_refill_at" timestamp with time zone,
	"enabled" boolean DEFAULT true,
	"rate_limit_enabled" boolean DEFAULT true,
	"rate_limit_time_window" integer DEFAULT 86400000,
	"rate_limit_max" integer DEFAULT 10,
	"request_count" integer DEFAULT 0,
	"remaining" integer,
	"last_request" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"permissions" text,
	"metadata" text
);
--> statement-breakpoint
CREATE TABLE "rate_limit" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"count" integer NOT NULL,
	"last_request" bigint NOT NULL,
	CONSTRAINT "rate_limit_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "commands" ADD CONSTRAINT "commands_instance_id_server_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."server_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_sessions" ADD CONSTRAINT "game_sessions_group_id_server_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."server_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instance_players" ADD CONSTRAINT "instance_players_instance_id_server_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."server_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queue_entries" ADD CONSTRAINT "queue_entries_group_id_server_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."server_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queue_entries" ADD CONSTRAINT "queue_entries_session_id_game_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."game_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queue_entry_players" ADD CONSTRAINT "queue_entry_players_queue_entry_id_queue_entries_id_fk" FOREIGN KEY ("queue_entry_id") REFERENCES "public"."queue_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_group_variants" ADD CONSTRAINT "server_group_variants_group_id_server_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."server_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_group_variants" ADD CONSTRAINT "server_group_variants_variant_id_server_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."server_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_instances" ADD CONSTRAINT "server_instances_group_id_server_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."server_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_instances" ADD CONSTRAINT "server_instances_variant_id_server_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."server_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_instances" ADD CONSTRAINT "server_instances_session_id_game_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."game_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_instances" ADD CONSTRAINT "server_instances_host_id_execution_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."execution_hosts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_variant_layers" ADD CONSTRAINT "server_variant_layers_variant_id_server_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."server_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_variant_layers" ADD CONSTRAINT "server_variant_layers_layer_id_template_layers_id_fk" FOREIGN KEY ("layer_id") REFERENCES "public"."template_layers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_variants" ADD CONSTRAINT "server_variants_id_template_layers_id_fk" FOREIGN KEY ("id") REFERENCES "public"."template_layers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_players" ADD CONSTRAINT "session_players_session_id_game_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."game_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_players" ADD CONSTRAINT "session_players_queue_entry_id_queue_entries_id_fk" FOREIGN KEY ("queue_entry_id") REFERENCES "public"."queue_entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_command_players" ADD CONSTRAINT "transfer_command_players_command_id_transfer_commands_id_fk" FOREIGN KEY ("command_id") REFERENCES "public"."transfer_commands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_commands" ADD CONSTRAINT "transfer_commands_instance_id_server_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."server_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_commands" ADD CONSTRAINT "transfer_commands_session_id_game_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."game_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variant_start_states" ADD CONSTRAINT "variant_start_states_group_id_server_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."server_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variant_start_states" ADD CONSTRAINT "variant_start_states_variant_id_server_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."server_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variant_start_states" ADD CONSTRAINT "variant_start_states_probe_instance_id_server_instances_id_fk" FOREIGN KEY ("probe_instance_id") REFERENCES "public"."server_instances"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variant_start_states" ADD CONSTRAINT "variant_start_states_last_failed_instance_id_server_instances_id_fk" FOREIGN KEY ("last_failed_instance_id") REFERENCES "public"."server_instances"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "commands_pending_idx" ON "commands" USING btree ("state","created_at");--> statement-breakpoint
CREATE INDEX "events_aggregate_idx" ON "events" USING btree ("aggregate_type","aggregate_id","created_at");--> statement-breakpoint
CREATE INDEX "execution_hosts_health_admin_idx" ON "execution_hosts" USING btree ("health_state","admin_state");--> statement-breakpoint
CREATE INDEX "game_sessions_group_state_idx" ON "game_sessions" USING btree ("group_id","state");--> statement-breakpoint
CREATE INDEX "game_sessions_instance_idx" ON "game_sessions" USING btree ("instance_id");--> statement-breakpoint
CREATE INDEX "instance_players_player_idx" ON "instance_players" USING btree ("player_id");--> statement-breakpoint
CREATE UNIQUE INDEX "operational_incidents_unresolved_fingerprint_idx" ON "operational_incidents" USING btree ("fingerprint") WHERE "operational_incidents"."state" <> 'RESOLVED';--> statement-breakpoint
CREATE INDEX "operational_incidents_state_last_observed_idx" ON "operational_incidents" USING btree ("state","last_observed_at");--> statement-breakpoint
CREATE INDEX "operational_incidents_group_state_idx" ON "operational_incidents" USING btree ("group_id","state");--> statement-breakpoint
CREATE INDEX "queue_entries_matchmaking_idx" ON "queue_entries" USING btree ("group_id","state","joined_at");--> statement-breakpoint
CREATE INDEX "queue_entries_session_idx" ON "queue_entries" USING btree ("session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "queue_entries_active_party_unique" ON "queue_entries" USING btree ("group_id","party_id") WHERE "queue_entries"."state" = 'QUEUED';--> statement-breakpoint
CREATE INDEX "queue_entry_players_player_idx" ON "queue_entry_players" USING btree ("player_id");--> statement-breakpoint
CREATE INDEX "registry_outbox_pending_idx" ON "registry_outbox" USING btree ("next_attempt_at") WHERE "registry_outbox"."published_at" IS NULL;--> statement-breakpoint
CREATE INDEX "server_group_variants_variant_idx" ON "server_group_variants" USING btree ("variant_id");--> statement-breakpoint
CREATE INDEX "server_instances_group_state_idx" ON "server_instances" USING btree ("group_id","lifecycle_state","availability_state");--> statement-breakpoint
CREATE UNIQUE INDEX "server_instances_session_unique" ON "server_instances" USING btree ("session_id") WHERE "server_instances"."session_id" IS NOT NULL
          AND "server_instances"."lifecycle_state" IN ('CREATING', 'STARTING', 'RUNNING', 'DRAINING');--> statement-breakpoint
CREATE UNIQUE INDEX "server_instances_active_replacement_unique" ON "server_instances" USING btree ("replaces_instance_id") WHERE "server_instances"."replaces_instance_id" IS NOT NULL
          AND "server_instances"."lifecycle_state" IN ('CREATING', 'STARTING', 'RUNNING');--> statement-breakpoint
CREATE INDEX "server_instances_host_state_idx" ON "server_instances" USING btree ("host_id","lifecycle_state");--> statement-breakpoint
CREATE INDEX "server_tps_metrics_bucket_idx" ON "server_tps_metrics" USING btree ("bucket_at");--> statement-breakpoint
CREATE INDEX "server_tps_metrics_group_bucket_idx" ON "server_tps_metrics" USING btree ("group_id","bucket_at");--> statement-breakpoint
CREATE UNIQUE INDEX "server_variant_layers_layer_unique" ON "server_variant_layers" USING btree ("variant_id","layer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "service_credentials_identity_unique" ON "service_credentials" USING btree ("kind","principal_id");--> statement-breakpoint
CREATE INDEX "session_players_player_idx" ON "session_players" USING btree ("player_id");--> statement-breakpoint
CREATE INDEX "session_players_queue_entry_idx" ON "session_players" USING btree ("queue_entry_id");--> statement-breakpoint
CREATE INDEX "transfer_command_players_pending_idx" ON "transfer_command_players" USING btree ("state","player_id");--> statement-breakpoint
CREATE INDEX "transfer_commands_due_idx" ON "transfer_commands" USING btree ("state","next_attempt_at");--> statement-breakpoint
CREATE INDEX "transfer_commands_session_idx" ON "transfer_commands" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "variant_start_states_due_idx" ON "variant_start_states" USING btree ("state","next_retry_at");--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "apikey_configId_idx" ON "apikey" USING btree ("config_id");--> statement-breakpoint
CREATE INDEX "apikey_referenceId_idx" ON "apikey" USING btree ("reference_id");--> statement-breakpoint
CREATE INDEX "apikey_key_idx" ON "apikey" USING btree ("key");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "single_administrator" ON "user" USING btree ((true));--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");
--> statement-breakpoint
INSERT INTO release_metadata (id, schema_version) VALUES (1, 1);
--> statement-breakpoint
INSERT INTO registry_state (id, revision) VALUES (1, 0);
