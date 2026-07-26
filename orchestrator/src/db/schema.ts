import {
  bigint,
  boolean,
  check,
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
    waitingTimeoutMs: integer("waiting_timeout_ms"),
    minimumInstances: integer("minimum_instances").notNull().default(0),
    maximumInstances: integer("maximum_instances").notNull(),
    minimumWarmInstances: integer("minimum_warm_instances").notNull().default(0),
    maximumWarmInstances: integer("maximum_warm_instances").notNull(),
    maximumPlayersPerInstance: integer("maximum_players_per_instance"),
    targetPlayersPerInstance: integer("target_players_per_instance"),
    startupTimeoutMs: integer("startup_timeout_ms").notNull(),
    drainingTimeoutMs: integer("draining_timeout_ms").notNull(),
    shutdownTimeoutMs: integer("shutdown_timeout_ms").notNull(),
    ...auditColumns,
  },
  (table) => [
    check("server_groups_capacity_check", sql`${table.maximumInstances} >= ${table.minimumInstances}`),
    check(
      "server_groups_warm_capacity_check",
      sql`${table.maximumWarmInstances} >= ${table.minimumWarmInstances}`,
    ),
  ],
);

export const serverVariants = pgTable(
  "server_variants",
  {
    id: text("id").primaryKey(),
    groupId: text("group_id")
      .notNull()
      .references(() => serverGroups.id),
    templatePath: text("template_path").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    revision: integer("revision").notNull(),
    selectionWeight: integer("selection_weight").notNull(),
    checksum: text("checksum").notNull(),
    runtimeSpec: jsonb("runtime_spec").notNull(),
    ...auditColumns,
  },
  (table) => [
    index("server_variants_group_idx").on(table.groupId),
    check("server_variants_weight_check", sql`${table.selectionWeight} > 0`),
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
    waitingDeadline: timestamp("waiting_deadline", { withTimezone: true }).notNull(),
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
    drainDeadline: timestamp("drain_deadline", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    runningAt: timestamp("running_at", { withTimezone: true }),
    drainingAt: timestamp("draining_at", { withTimezone: true }),
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
    state: queueEntryStateEnum("state").notNull().default("QUEUED"),
    joinedAt: timestamp("joined_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("queue_entries_matchmaking_idx").on(table.groupId, table.state, table.joinedAt),
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
    teamIndex: integer("team_index").notNull(),
    state: sessionPlayerStateEnum("state").notNull().default("SELECTED"),
    selectedAt: timestamp("selected_at", { withTimezone: true }).defaultNow().notNull(),
    connectedAt: timestamp("connected_at", { withTimezone: true }),
    leftAt: timestamp("left_at", { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.sessionId, table.playerId] }),
    index("session_players_player_idx").on(table.playerId),
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
  },
  (table) => [
    primaryKey({ columns: [table.instanceId, table.playerId] }),
    index("instance_players_player_idx").on(table.playerId),
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

export const schema = {
  serverGroups,
  serverVariants,
  gameSessions,
  serverInstances,
  queueEntries,
  queueEntryPlayers,
  sessionPlayers,
  instancePlayers,
  commands,
  nodes,
  events,
  proxyHeartbeats,
};

export type DatabaseSchema = typeof schema;
