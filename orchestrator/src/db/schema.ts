import {
  bigint,
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import {
  availabilityStates,
  lifecycleStates,
  sessionPlayerStates,
  sessionStates,
} from "../domain/types.ts";
import type {
  TemplateFileSummary,
  VariantRuntimePatch,
  VariantRuntimeSpec,
} from "../domain/types.ts";

export const groupTypeEnum = pgEnum("group_type", ["hub", "minigame"]);
export const lifecycleStateEnum = pgEnum("lifecycle_state", lifecycleStates);
export const availabilityStateEnum = pgEnum("availability_state", availabilityStates);
export const sessionStateEnum = pgEnum("session_state", sessionStates);
export const sessionPlayerStateEnum = pgEnum("session_player_state", sessionPlayerStates);
export const queueEntryStateEnum = pgEnum("queue_entry_state", [
  "QUEUED",
  "SELECTED",
  "LEFT",
]);
export const commandStateEnum = pgEnum("command_state", [
  "PENDING",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
]);

const auditColumns = {
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
};

export const serverGroups = pgTable(
  "server_groups",
  {
    id: text("id").primaryKey(),
    type: groupTypeEnum("type").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    minimumPlayers: integer("minimum_players"),
    maximumPlayers: integer("maximum_players"),
    teamCount: integer("team_count"),
    teamSize: integer("team_size"),
    candidateWindow: integer("candidate_window"),
    instanceAcquisitionTimeoutMs: integer("instance_acquisition_timeout_ms"),
    lobbyStaleTimeoutMs: integer("lobby_stale_timeout_ms"),
    minimumPlayersPerTeam: integer("minimum_players_per_team"),
    maximumTeamSpread: integer("maximum_team_spread"),
    minimumInstances: integer("minimum_instances").notNull().default(0),
    maximumInstances: integer("maximum_instances").notNull(),
    minimumWarmInstances: integer("minimum_warm_instances").notNull().default(0),
    maximumWarmInstances: integer("maximum_warm_instances").notNull(),
    maximumPlayersPerInstance: integer("maximum_players_per_instance"),
    targetPlayersPerInstance: integer("target_players_per_instance"),
    startupTimeoutMs: integer("startup_timeout_ms").notNull(),
    drainTimeoutMs: integer("drain_timeout_ms").notNull(),
    cancelledDrainTimeoutMs: integer("cancelled_drain_timeout_ms").notNull(),
    shutdownTimeoutMs: integer("shutdown_timeout_ms").notNull(),
    transferTimeoutMs: integer("transfer_timeout_ms").notNull(),
    playerStaleTimeoutMs: integer("player_stale_timeout_ms").notNull(),
    instanceLifetimeMs: integer("instance_lifetime_ms"),
    ...auditColumns,
  },
  (table) => [
    check("server_groups_capacity_check", sql`${table.maximumInstances} >= ${table.minimumInstances}`),
    check(
      "server_groups_warm_capacity_check",
      sql`${table.maximumWarmInstances} >= ${table.minimumWarmInstances}`,
    ),
    check(
      "server_groups_matchmaking_policy_check",
      sql`${table.type} <> 'minigame' OR (
        ${table.candidateWindow} > 0
        AND ${table.minimumPlayersPerTeam} BETWEEN 0 AND ${table.teamSize}
        AND ${table.maximumTeamSpread} BETWEEN 0 AND ${table.teamSize}
      )`,
    ),
    check(
      "server_groups_instance_lifetime_check",
      sql`${table.instanceLifetimeMs} IS NULL OR ${table.instanceLifetimeMs} > 0`,
    ),
  ],
);

export const templateLayers = pgTable(
  "template_layers",
  {
    id: text("id").primaryKey(),
    templatePath: text("template_path").notNull(),
    checksum: text("checksum").notNull(),
    runtimePatch: jsonb("runtime_patch").$type<VariantRuntimePatch>().notNull(),
    fileSummary: jsonb("file_summary").$type<TemplateFileSummary>().notNull(),
    ...auditColumns,
  },
);

export const serverVariants = pgTable(
  "server_variants",
  {
    id: text("id").primaryKey().references(() => templateLayers.id),
    revision: integer("revision").notNull(),
    checksum: text("checksum").notNull(),
    runtimeSpec: jsonb("runtime_spec").$type<VariantRuntimeSpec>().notNull(),
    ...auditColumns,
  },
);

export const serverVariantLayers = pgTable(
  "server_variant_layers",
  {
    variantId: text("variant_id").notNull().references(() => serverVariants.id, {
      onDelete: "cascade",
    }),
    layerId: text("layer_id").notNull().references(() => templateLayers.id),
    ordinal: integer("ordinal").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.variantId, table.ordinal] }),
    uniqueIndex("server_variant_layers_layer_unique").on(table.variantId, table.layerId),
    check("server_variant_layers_ordinal_check", sql`${table.ordinal} >= 0`),
  ],
);

export const serverGroupVariants = pgTable(
  "server_group_variants",
  {
    groupId: text("group_id").notNull().references(() => serverGroups.id, {
      onDelete: "cascade",
    }),
    variantId: text("variant_id").notNull().references(() => serverVariants.id),
    enabled: boolean("enabled").notNull().default(true),
    selectionWeight: integer("selection_weight").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.groupId, table.variantId] }),
    index("server_group_variants_variant_idx").on(table.variantId),
    check("server_group_variants_weight_check", sql`${table.selectionWeight} > 0`),
  ],
);

export const gameSessions = pgTable(
  "game_sessions",
  {
    id: text("id").primaryKey(),
    groupId: text("group_id")
      .notNull()
      .references(() => serverGroups.id),
    instanceId: text("instance_id"),
    state: sessionStateEnum("state").notNull(),
    assignmentRevision: integer("assignment_revision").notNull().default(1),
    assignmentAcknowledgedAt: timestamp("assignment_acknowledged_at", { withTimezone: true }),
    instanceAcquisitionDeadline: timestamp("instance_acquisition_deadline", { withTimezone: true }),
    lobbyStaleDeadline: timestamp("lobby_stale_deadline", { withTimezone: true }),
    transferStartedAt: timestamp("transfer_started_at", { withTimezone: true }),
    retryCount: integer("retry_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("game_sessions_group_state_idx").on(table.groupId, table.state),
    index("game_sessions_instance_idx").on(table.instanceId),
  ],
);

export const serverInstances = pgTable(
  "server_instances",
  {
    id: text("id").primaryKey(),
    groupId: text("group_id")
      .notNull()
      .references(() => serverGroups.id),
    variantId: text("variant_id")
      .notNull()
      .references(() => serverVariants.id),
    sessionId: text("session_id").references(() => gameSessions.id),
    lifecycleState: lifecycleStateEnum("lifecycle_state").notNull(),
    availabilityState: availabilityStateEnum("availability_state").notNull(),
    containerId: text("container_id"),
    runtimePath: text("runtime_path"),
    endpoint: text("endpoint"),
    playerCount: integer("player_count").notNull().default(0),
    startupDeadline: timestamp("startup_deadline", { withTimezone: true }),
    renewalDeadline: timestamp("renewal_deadline", { withTimezone: true }),
    replacesInstanceId: text("replaces_instance_id"),
    drainDeadline: timestamp("drain_deadline", { withTimezone: true }),
    drainReason: text("drain_reason"),
    shutdownDeadline: timestamp("shutdown_deadline", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    startingAt: timestamp("starting_at", { withTimezone: true }),
    runningAt: timestamp("running_at", { withTimezone: true }),
    drainingAt: timestamp("draining_at", { withTimezone: true }),
    stoppingAt: timestamp("stopping_at", { withTimezone: true }),
    stoppedAt: timestamp("stopped_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("server_instances_group_state_idx").on(
      table.groupId,
      table.lifecycleState,
      table.availabilityState,
    ),
    uniqueIndex("server_instances_session_unique")
      .on(table.sessionId)
      .where(
        sql`${table.sessionId} IS NOT NULL
          AND ${table.lifecycleState} IN ('CREATING', 'STARTING', 'RUNNING', 'DRAINING')`,
      ),
    uniqueIndex("server_instances_active_replacement_unique")
      .on(table.replacesInstanceId)
      .where(
        sql`${table.replacesInstanceId} IS NOT NULL
          AND ${table.lifecycleState} IN ('CREATING', 'STARTING', 'RUNNING')`,
      ),
    check(
      "server_instances_reserved_session_check",
      sql`${table.availabilityState} <> 'RESERVED' OR ${table.sessionId} IS NOT NULL`,
    ),
  ],
);

export const queueEntries = pgTable(
  "queue_entries",
  {
    id: text("id").primaryKey(),
    groupId: text("group_id")
      .notNull()
      .references(() => serverGroups.id),
    partyId: text("party_id").notNull(),
    sessionId: text("session_id").references(() => gameSessions.id, { onDelete: "set null" }),
    state: queueEntryStateEnum("state").notNull().default("QUEUED"),
    transferStartedAt: timestamp("transfer_started_at", { withTimezone: true }),
    joinedAt: timestamp("joined_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("queue_entries_matchmaking_idx").on(table.groupId, table.state, table.joinedAt),
    index("queue_entries_session_idx").on(table.sessionId),
    uniqueIndex("queue_entries_active_party_unique")
      .on(table.groupId, table.partyId)
      .where(sql`${table.state} = 'QUEUED'`),
  ],
);

export const queueEntryPlayers = pgTable(
  "queue_entry_players",
  {
    queueEntryId: text("queue_entry_id")
      .notNull()
      .references(() => queueEntries.id, { onDelete: "cascade" }),
    playerId: uuid("player_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.queueEntryId, table.playerId] }),
    index("queue_entry_players_player_idx").on(table.playerId),
  ],
);

export const sessionPlayers = pgTable(
  "session_players",
  {
    sessionId: text("session_id")
      .notNull()
      .references(() => gameSessions.id, { onDelete: "cascade" }),
    playerId: uuid("player_id").notNull(),
    partyId: text("party_id").notNull(),
    queueEntryId: text("queue_entry_id").references(() => queueEntries.id, {
      onDelete: "set null",
    }),
    state: sessionPlayerStateEnum("state").notNull().default("SELECTED"),
    selectedAt: timestamp("selected_at", { withTimezone: true }).defaultNow().notNull(),
    transferringAt: timestamp("transferring_at", { withTimezone: true }),
    transferDeadline: timestamp("transfer_deadline", { withTimezone: true }),
    connectedAt: timestamp("connected_at", { withTimezone: true }),
    leftAt: timestamp("left_at", { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.sessionId, table.playerId] }),
    index("session_players_player_idx").on(table.playerId),
    index("session_players_queue_entry_idx").on(table.queueEntryId),
  ],
);

export const instancePlayers = pgTable(
  "instance_players",
  {
    instanceId: text("instance_id")
      .notNull()
      .references(() => serverInstances.id, { onDelete: "cascade" }),
    playerId: uuid("player_id").notNull(),
    connectedAt: timestamp("connected_at", { withTimezone: true }).defaultNow().notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
    staleDeadline: timestamp("stale_deadline", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.instanceId, table.playerId] }),
    index("instance_players_player_idx").on(table.playerId),
  ],
);

export const transferCommands = pgTable(
  "transfer_commands",
  {
    id: text("id").primaryKey(),
    instanceId: text("instance_id")
      .notNull()
      .references(() => serverInstances.id, { onDelete: "cascade" }),
    sessionId: text("session_id").references(() => gameSessions.id, { onDelete: "cascade" }),
    payload: jsonb("payload").notNull(),
    state: text("state").notNull().default("PENDING"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    index("transfer_commands_due_idx").on(table.state, table.nextAttemptAt),
    index("transfer_commands_session_idx").on(table.sessionId),
    check(
      "transfer_commands_state_check",
      sql`${table.state} IN ('PENDING', 'COMPLETED', 'EXPIRED', 'CANCELLED')`,
    ),
  ],
);

export const commands = pgTable(
  "commands",
  {
    id: text("id").primaryKey(),
    instanceId: text("instance_id").references(() => serverInstances.id),
    operation: text("operation").notNull(),
    state: commandStateEnum("state").notNull().default("PENDING"),
    attempts: integer("attempts").notNull().default(0),
    payload: jsonb("payload"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [index("commands_pending_idx").on(table.state, table.createdAt)],
);

export const nodes = pgTable("nodes", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull().default("LOCAL_DOCKER"),
  enabled: boolean("enabled").notNull().default(true),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
  metadata: jsonb("metadata"),
});

export const events = pgTable(
  "events",
  {
    id: text("id").primaryKey(),
    aggregateType: text("aggregate_type").notNull(),
    aggregateId: text("aggregate_id").notNull(),
    type: text("type").notNull(),
    payload: jsonb("payload"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("events_aggregate_idx").on(table.aggregateType, table.aggregateId, table.createdAt),
  ],
);

export const proxyHeartbeats = pgTable("proxy_heartbeats", {
  proxyId: text("proxy_id").primaryKey(),
  playerCount: integer("player_count").notNull().default(0),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
});

export const serverTpsMetrics = pgTable(
  "server_tps_metrics",
  {
    groupId: text("group_id").notNull(),
    variantId: text("variant_id").notNull(),
    bucketAt: timestamp("bucket_at", { withTimezone: true }).notNull(),
    oneMinuteSum: doublePrecision("one_minute_sum").notNull(),
    fiveMinutesSum: doublePrecision("five_minutes_sum").notNull(),
    fifteenMinutesSum: doublePrecision("fifteen_minutes_sum").notNull(),
    sampleCount: integer("sample_count").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.groupId, table.variantId, table.bucketAt] }),
    index("server_tps_metrics_bucket_idx").on(table.bucketAt),
    index("server_tps_metrics_group_bucket_idx").on(table.groupId, table.bucketAt),
    check("server_tps_metrics_sample_count_check", sql`${table.sampleCount} > 0`),
  ],
);

export const schema = {
  serverGroups,
  templateLayers,
  serverVariants,
  serverVariantLayers,
  serverGroupVariants,
  gameSessions,
  serverInstances,
  queueEntries,
  queueEntryPlayers,
  sessionPlayers,
  instancePlayers,
  transferCommands,
  commands,
  nodes,
  events,
  proxyHeartbeats,
  serverTpsMetrics,
};

export type DatabaseSchema = typeof schema;
