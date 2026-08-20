import type postgres from "postgres";
import type { Database } from "../db/client.ts";
import { sql, eq, ne, and, isNotNull, inArray, desc, asc, or, notInArray } from "drizzle-orm";
import {
  serverGroups,
  serverGroupVariants,
  serverVariantLayers,
  serverVariants,
  templateLayers,
  serverInstances,
  gameSessions,
  queueEntries,
  queueEntryPlayers,
  instancePlayers,
  commands,
  events,
  sessionPlayers,
  transferCommands,
  executionHosts,
} from "../db/schema.ts";
import type {
  DashboardClusterSnapshot,
  DashboardGroup,
  DashboardInstance,
  DashboardInstanceDetail,
  DashboardQueueDetail,
  DashboardQueueSummary,
  DashboardSession,
  DashboardSessionDetail,
  DashboardVariant,
  DashboardVariantGraph,
  ActiveDeadline,
  DashboardHost,
} from "../domain/dashboard.ts";
import type {
  AvailabilityState,
  GroupType,
  LifecycleState,
  SessionPlayerState,
  SessionState,
  VariantRuntimeSpec,
  ExecutionHostAdminState,
  ExecutionHostHealthState,
} from "../domain/types.ts";
import {
  computeFeasibleProfiles,
  selectRecommendedProfile,
} from "../domain/matchmaking.ts";

type DatabaseTimestamp = Date | string;

export interface GroupRow {
  id: string;
  type: GroupType;
  enabled: boolean;
  minimum_players: number | null;
  maximum_players: number | null;
  team_count: number | null;
  team_size: number | null;
  candidate_window?: number | null;
  instance_acquisition_timeout_ms?: number | null;
  lobby_stale_timeout_ms?: number | null;
  minimum_players_per_team?: number | null;
  maximum_team_spread?: number | null;
  minimum_instances: number;
  maximum_instances: number;
  minimum_warm_instances: number;
  maximum_warm_instances: number;
  maximum_players_per_instance: number | null;
  target_players_per_instance: number | null;
  startup_timeout_ms: number;
  drain_timeout_ms: number;
  cancelled_drain_timeout_ms: number;
  shutdown_timeout_ms: number;
  transfer_timeout_ms: number;
  player_stale_timeout_ms: number;
  instance_lifetime_ms: number | null;
}

export interface VariantRow {
  id: string;
  group_id: string;
  enabled: boolean;
  revision: number;
  selection_weight: number;
  runtime_spec: VariantRuntimeSpec;
}

export interface InstanceRow {
  id: string;
  host_id?: string | null;
  group_id: string;
  variant_id: string;
  session_id: string | null;
  lifecycle_state: LifecycleState;
  availability_state: AvailabilityState;
  endpoint: string | null;
  player_count: number;
  maximum_players: number;
  created_at: DatabaseTimestamp;
  starting_at: DatabaseTimestamp | null;
  startup_deadline: DatabaseTimestamp | null;
  running_at: DatabaseTimestamp | null;
  renewal_deadline: DatabaseTimestamp | null;
  replaces_instance_id: string | null;
  draining_at: DatabaseTimestamp | null;
  drain_deadline: DatabaseTimestamp | null;
  drain_reason: string | null;
  stopping_at: DatabaseTimestamp | null;
  shutdown_deadline: DatabaseTimestamp | null;
  updated_at: DatabaseTimestamp;
}

export interface HostRow {
  id: string;
  control_url: string;
  game_address: string;
  health_state: ExecutionHostHealthState;
  admin_state: ExecutionHostAdminState;
  allocatable_cpu: number;
  reserved_cpu: number;
  allocatable_memory_bytes: number;
  reserved_memory_bytes: number;
  active_instance_count: number;
  agent_version: string;
  last_heartbeat_at: DatabaseTimestamp;
  last_control_contact_at: DatabaseTimestamp | null;
  last_error: string | null;
}

export interface SessionRow {
  id: string;
  group_id: string;
  instance_id: string | null;
  state: SessionState;
  assignment_revision: number;
  assignment_acknowledged_at: DatabaseTimestamp | null;
  instance_acquisition_deadline: DatabaseTimestamp | null;
  lobby_stale_deadline?: DatabaseTimestamp | null;
  retry_count: number;
  maximum_player_count: number;
  active_player_count: number;
  connected_player_count: number;
  team_count: number;
  created_at: DatabaseTimestamp;
  started_at: DatabaseTimestamp | null;
  finished_at: DatabaseTimestamp | null;
  updated_at: DatabaseTimestamp;
}

export interface QueueSummaryRow {
  group_id: string;
  party_count: number;
  player_count: number;
  oldest_joined_at: DatabaseTimestamp | null;
}

export interface DashboardRows {
  readonly hosts?: readonly HostRow[];
  readonly groups: readonly GroupRow[];
  readonly variants: readonly VariantRow[];
  readonly instances: readonly InstanceRow[];
  readonly sessions: readonly SessionRow[];
  readonly queues: readonly QueueSummaryRow[];
}

function requiredIso(value: DatabaseTimestamp): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}

function iso(value: DatabaseTimestamp | null): string | null {
  return value === null ? null : requiredIso(value);
}

function toVariant(row: VariantRow): DashboardVariant {
  return {
    id: row.id,
    enabled: row.enabled,
    revision: row.revision,
    weight: row.selection_weight,
    runtime: row.runtime_spec,
  };
}

function toInstance(row: InstanceRow): DashboardInstance {
  return {
    id: row.id,
    hostId: row.host_id ?? null,
    variantId: row.variant_id,
    sessionId: row.session_id,
    lifecycleState: row.lifecycle_state,
    availabilityState: row.availability_state,
    endpoint: row.endpoint,
    playerCount: row.player_count,
    maximumPlayers: row.maximum_players,
    createdAt: requiredIso(row.created_at),
    startingAt: iso(row.starting_at),
    startupDeadline: iso(row.startup_deadline),
    runningAt: iso(row.running_at),
    renewalDeadline: iso(row.renewal_deadline),
    replacesInstanceId: row.replaces_instance_id,
    drainingAt: iso(row.draining_at),
    drainDeadline: iso(row.drain_deadline),
    drainReason: row.drain_reason,
    stoppingAt: iso(row.stopping_at),
    shutdownDeadline: iso(row.shutdown_deadline),
    updatedAt: requiredIso(row.updated_at),
  };
}

function toHost(row: HostRow): DashboardHost {
  return {
    id: row.id,
    controlUrl: row.control_url,
    gameAddress: row.game_address,
    healthState: row.health_state,
    adminState: row.admin_state,
    allocatableCpu: row.allocatable_cpu,
    reservedCpu: row.reserved_cpu,
    allocatableMemoryBytes: row.allocatable_memory_bytes,
    reservedMemoryBytes: row.reserved_memory_bytes,
    activeInstanceCount: row.active_instance_count,
    agentVersion: row.agent_version,
    lastHeartbeatAt: requiredIso(row.last_heartbeat_at),
    lastControlContactAt: iso(row.last_control_contact_at),
    lastError: row.last_error,
  };
}

function toSession(row: SessionRow): DashboardSession {
  return {
    id: row.id,
    instanceId: row.instance_id,
    state: row.state,
    assignmentRevision: row.assignment_revision,
    assignmentAcknowledgedAt: iso(row.assignment_acknowledged_at),
    instanceAcquisitionDeadline: iso(row.instance_acquisition_deadline),
    lobbyStaleDeadline: iso(row.lobby_stale_deadline ?? null),
    retryCount: row.retry_count,
    maximumPlayerCount: row.maximum_player_count,
    activePlayerCount: row.active_player_count,
    connectedPlayerCount: row.connected_player_count,
    teamCount: row.team_count,
    createdAt: requiredIso(row.created_at),
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
    updatedAt: requiredIso(row.updated_at),
  };
}

export function activeInstanceDeadline(row: InstanceRow): ActiveDeadline | null {
  if (row.lifecycle_state === "STARTING" && row.startup_deadline) {
    return { kind: "INSTANCE_STARTUP", at: requiredIso(row.startup_deadline) };
  }
  if (row.lifecycle_state === "RUNNING" && row.renewal_deadline) {
    return { kind: "INSTANCE_RENEWAL", at: requiredIso(row.renewal_deadline) };
  }
  if (row.lifecycle_state === "DRAINING" && row.drain_deadline) {
    return {
      kind:
        row.drain_reason === "SESSION_CANCELLED"
          ? "CANCELLED_INSTANCE_DRAIN"
          : "INSTANCE_DRAIN",
      at: requiredIso(row.drain_deadline),
    };
  }
  if (row.lifecycle_state === "STOPPING" && row.shutdown_deadline) {
    return { kind: "INSTANCE_SHUTDOWN", at: requiredIso(row.shutdown_deadline) };
  }
  return null;
}

export function activeSessionDeadline(
  row: SessionRow,
  transfers: readonly { state: string; expires_at: DatabaseTimestamp }[],
): ActiveDeadline | null {
  if (row.state === "WAITING_FOR_INSTANCE" && row.instance_acquisition_deadline) {
    return {
      kind: "INSTANCE_ACQUISITION",
      at: requiredIso(row.instance_acquisition_deadline),
    };
  }
  if (row.state !== "TRANSFERRING" && row.state !== "WAITING") return null;
  const pendingTransfer = transfers
    .filter((transfer) => transfer.state === "PENDING")
    .toSorted(
      (left, right) =>
        new Date(left.expires_at).getTime() - new Date(right.expires_at).getTime(),
    )[0];
  if (pendingTransfer) {
    return { kind: "PLAYER_TRANSFER", at: requiredIso(pendingTransfer.expires_at) };
  }
  if (row.lobby_stale_deadline) {
    return {
      kind: "LOBBY_STALE",
      at: requiredIso(row.lobby_stale_deadline),
    };
  }
  return null;
}

const emptyQueue: DashboardQueueSummary = {
  partyCount: 0,
  playerCount: 0,
  oldestJoinedAt: null,
};

// Assemble normalized database rows into the dashboard cluster graph.
export function assembleClusterSnapshot(
  rows: DashboardRows,
  generatedAt = new Date(),
): DashboardClusterSnapshot {
  const variantsByGroup = new Map<string, DashboardVariant[]>();
  const instancesByGroup = new Map<string, DashboardInstance[]>();
  const sessionsByGroup = new Map<string, DashboardSession[]>();
  const queuesByGroup = new Map<string, DashboardQueueSummary>();

  for (const variant of rows.variants) {
    const groupVariants = variantsByGroup.get(variant.group_id) ?? [];
    groupVariants.push(toVariant(variant));
    variantsByGroup.set(variant.group_id, groupVariants);
  }
  for (const instance of rows.instances) {
    const groupInstances = instancesByGroup.get(instance.group_id) ?? [];
    groupInstances.push(toInstance(instance));
    instancesByGroup.set(instance.group_id, groupInstances);
  }
  for (const session of rows.sessions) {
    const groupSessions = sessionsByGroup.get(session.group_id) ?? [];
    groupSessions.push(toSession(session));
    sessionsByGroup.set(session.group_id, groupSessions);
  }
  for (const queue of rows.queues) {
    queuesByGroup.set(queue.group_id, {
      partyCount: queue.party_count,
      playerCount: queue.player_count,
      oldestJoinedAt: iso(queue.oldest_joined_at),
    });
  }

  const groups: DashboardGroup[] = rows.groups.map((group) => {
    const instances = instancesByGroup.get(group.id) ?? [];
    const activeInstances = instances.filter(
      (instance) =>
        instance.lifecycleState === "CREATING" ||
        instance.lifecycleState === "STARTING" ||
        instance.lifecycleState === "RUNNING" ||
        instance.lifecycleState === "DRAINING",
    );
    const warmInstances = activeInstances.filter(
      (instance) =>
        instance.lifecycleState === "RUNNING" && instance.availabilityState === "OPEN",
    ).length;
    const pendingWarmInstances = activeInstances.filter(
      (instance) =>
        (instance.lifecycleState === "CREATING" ||
          instance.lifecycleState === "STARTING") &&
        instance.availabilityState === "OPEN",
    ).length;
    const reservedInstances = activeInstances.filter(
      (instance) => instance.availabilityState === "RESERVED",
    ).length;
    return {
      id: group.id,
      type: group.type,
      enabled: group.enabled,
      capacity: {
        minimumInstances: group.minimum_instances,
        maximumInstances: group.maximum_instances,
        minimumWarmInstances: group.minimum_warm_instances,
        maximumWarmInstances: group.maximum_warm_instances,
        activeInstances: activeInstances.length,
        warmInstances,
        pendingWarmInstances,
        reservedInstances,
      },
      timeouts: {
        startupMs: group.startup_timeout_ms,
        drainMs: group.drain_timeout_ms,
        cancelledDrainMs: group.cancelled_drain_timeout_ms,
        shutdownMs: group.shutdown_timeout_ms,
        transferMs: group.transfer_timeout_ms,
        playerStaleMs: group.player_stale_timeout_ms,
        instanceLifetimeMs: group.instance_lifetime_ms,
        instanceAcquisitionMs: group.instance_acquisition_timeout_ms ?? null,
        lobbyStaleMs: group.lobby_stale_timeout_ms ?? null,
      },
      matchmaking:
        group.type === "minigame" &&
        group.minimum_players !== null &&
        group.maximum_players !== null &&
        group.team_count !== null &&
        group.team_size !== null
          ? {
              minimumPlayers: group.minimum_players,
              maximumPlayers: group.maximum_players,
              teamCount: group.team_count,
              teamSize: group.team_size,
              candidateWindow: group.candidate_window ?? 20,
              minimumPlayersPerTeam: group.minimum_players_per_team ?? 0,
              maximumTeamSpread: group.maximum_team_spread ?? group.team_size,
            }
          : null,
      routing:
        group.type === "hub" &&
        group.maximum_players_per_instance !== null &&
        group.target_players_per_instance !== null
          ? {
              maximumPlayersPerInstance: group.maximum_players_per_instance,
              targetPlayersPerInstance: group.target_players_per_instance,
            }
          : null,
      queue: queuesByGroup.get(group.id) ?? emptyQueue,
      variants: variantsByGroup.get(group.id) ?? [],
      instances,
      sessions: sessionsByGroup.get(group.id) ?? [],
    };
  });

  const allInstances = groups.flatMap((group) => group.instances);
  const allSessions = groups.flatMap((group) => group.sessions);
  return {
    schemaVersion: 3,
    generatedAt: generatedAt.toISOString(),
    summary: {
      enabledGroups: groups.filter((group) => group.enabled).length,
      activeInstances: groups.reduce(
        (total, group) => total + group.capacity.activeInstances,
        0,
      ),
      runningInstances: allInstances.filter(
        (instance) => instance.lifecycleState === "RUNNING",
      ).length,
      warmInstances: groups.reduce(
        (total, group) => total + group.capacity.warmInstances,
        0,
      ),
      pendingWarmInstances: groups.reduce(
        (total, group) => total + group.capacity.pendingWarmInstances,
        0,
      ),
      reservedInstances: groups.reduce(
        (total, group) => total + group.capacity.reservedInstances,
        0,
      ),
      playersOnline: allInstances.reduce(
        (total, instance) => total + instance.playerCount,
        0,
      ),
      activeSessions: allSessions.filter(
        (session) =>
          session.state !== "FINISHED" &&
          session.state !== "CANCELLED" &&
          session.state !== "FAILED",
      ).length,
      queuedParties: groups.reduce(
        (total, group) => total + group.queue.partyCount,
        0,
      ),
      queuedPlayers: groups.reduce(
        (total, group) => total + group.queue.playerCount,
        0,
      ),
    },
    hosts: (rows.hosts ?? []).map(toHost),
    groups,
  };
}

export function normalizeDashboardLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) return 50;
  return Math.max(1, Math.min(200, Math.trunc(value ?? 50)));
}

export class DashboardService {
  public constructor(private readonly db: Database) {}

  public async getCluster(): Promise<DashboardClusterSnapshot> {
    const rows = await this.db.transaction(async (tx) => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
      return this.readClusterRows(tx);
    });
    return assembleClusterSnapshot(rows);
  }

  public async getQueue(
    groupId: string,
    requestedLimit?: number,
  ): Promise<DashboardQueueDetail | null> {
    const limit = normalizeDashboardLimit(requestedLimit);
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
      
      const groups = await tx.select({ id: serverGroups.id })
        .from(serverGroups)
        .where(eq(serverGroups.id, groupId));
      if (!groups[0]) return null;

      const totals = await tx.select({
        party_count: sql<number>`count(DISTINCT ${queueEntries.id})::int`,
        player_count: sql<number>`count(${queueEntryPlayers.playerId})::int`
      })
      .from(queueEntries)
      .leftJoin(queueEntryPlayers, eq(queueEntryPlayers.queueEntryId, queueEntries.id))
      .where(and(
        eq(queueEntries.groupId, groupId),
        eq(queueEntries.state, 'QUEUED')
      ));

      const entries = await tx.select({
        id: queueEntries.id,
        party_id: queueEntries.partyId,
        joined_at: queueEntries.joinedAt,
        players: sql<string[]>`coalesce(array_agg(${queueEntryPlayers.playerId}::text ORDER BY ${queueEntryPlayers.playerId}) FILTER (WHERE ${queueEntryPlayers.playerId} IS NOT NULL), ARRAY[]::text[])`
      })
      .from(queueEntries)
      .leftJoin(queueEntryPlayers, eq(queueEntryPlayers.queueEntryId, queueEntries.id))
      .where(and(
        eq(queueEntries.groupId, groupId),
        eq(queueEntries.state, 'QUEUED')
      ))
      .groupBy(queueEntries.id)
      .orderBy(asc(queueEntries.joinedAt), asc(queueEntries.id))
      .limit(limit);

      const totalParties = totals[0]?.party_count ?? 0;
      return {
        schemaVersion: 2,
        generatedAt: new Date().toISOString(),
        groupId,
        totalParties,
        totalPlayers: totals[0]?.player_count ?? 0,
        truncated: totalParties > entries.length,
        entries: entries.map((entry) => ({
          id: entry.id,
          partyId: entry.party_id,
          joinedAt: requiredIso(entry.joined_at),
          players: entry.players,
        })),
      };
    });
  }

  public async getVariants(groupId: string): Promise<DashboardVariantGraph | null> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
      const groups = await tx.select({ id: serverGroups.id })
        .from(serverGroups)
        .where(eq(serverGroups.id, groupId));
      if (!groups[0]) return null;

      const variants = await tx.select({
        id: serverVariants.id,
        enabled: serverGroupVariants.enabled,
        revision: serverVariants.revision,
        selection_weight: serverGroupVariants.selectionWeight,
        checksum: serverVariants.checksum,
        runtime_spec: serverVariants.runtimeSpec,
      })
        .from(serverGroupVariants)
        .innerJoin(serverVariants, eq(serverVariants.id, serverGroupVariants.variantId))
        .where(eq(serverGroupVariants.groupId, groupId))
        .orderBy(asc(serverVariants.id));

      const variantIds = variants.map((variant) => variant.id);
      const layerRows = variantIds.length === 0
        ? []
        : await tx.select({
          variant_id: serverVariantLayers.variantId,
          ordinal: serverVariantLayers.ordinal,
          id: templateLayers.id,
          checksum: templateLayers.checksum,
          runtime_patch: templateLayers.runtimePatch,
          file_summary: templateLayers.fileSummary,
        })
          .from(serverVariantLayers)
          .innerJoin(templateLayers, eq(templateLayers.id, serverVariantLayers.layerId))
          .where(inArray(serverVariantLayers.variantId, variantIds))
          .orderBy(asc(serverVariantLayers.variantId), asc(serverVariantLayers.ordinal));

      const uniqueLayers = new Map<string, DashboardVariantGraph["layers"][number]>();
      const layerIdsByVariant = new Map<string, string[]>();
      for (const layer of layerRows) {
        uniqueLayers.set(layer.id, {
          id: layer.id,
          checksum: layer.checksum,
          runtime: layer.runtime_patch,
          files: layer.file_summary,
        });
        const ids = layerIdsByVariant.get(layer.variant_id) ?? [];
        ids.push(layer.id);
        layerIdsByVariant.set(layer.variant_id, ids);
      }

      return {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        groupId,
        layers: [...uniqueLayers.values()],
        variants: variants.map((variant) => ({
          id: variant.id,
          enabled: variant.enabled,
          revision: variant.revision,
          weight: variant.selection_weight,
          checksum: variant.checksum,
          runtime: variant.runtime_spec,
          layers: layerIdsByVariant.get(variant.id) ?? [],
        })),
      };
    });
  }

  public async getInstance(instanceId: string): Promise<DashboardInstanceDetail | null> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
      
      const instances = await tx.select({
        id: serverInstances.id,
        host_id: serverInstances.hostId,
        group_id: serverInstances.groupId,
        variant_id: serverInstances.variantId,
        session_id: serverInstances.sessionId,
        lifecycle_state: serverInstances.lifecycleState,
        availability_state: serverInstances.availabilityState,
        endpoint: serverInstances.endpoint,
        player_count: serverInstances.playerCount,
        maximum_players: sql<number>`coalesce(${serverGroups.maximumPlayersPerInstance}, ${serverGroups.maximumPlayers}, 0)::int`,
        created_at: serverInstances.createdAt,
        starting_at: serverInstances.startingAt,
        startup_deadline: serverInstances.startupDeadline,
        running_at: serverInstances.runningAt,
        renewal_deadline: serverInstances.renewalDeadline,
        replaces_instance_id: serverInstances.replacesInstanceId,
        draining_at: serverInstances.drainingAt,
        drain_deadline: serverInstances.drainDeadline,
        drain_reason: serverInstances.drainReason,
        stopping_at: serverInstances.stoppingAt,
        shutdown_deadline: serverInstances.shutdownDeadline,
        updated_at: serverInstances.updatedAt,
        
        group_type: serverGroups.type,
        container_id: serverInstances.containerId,
        runtime_path: serverInstances.runtimePath,
        stopped_at: serverInstances.stoppedAt,
        checksum: serverVariants.checksum,
        variant_enabled: sql<boolean>`coalesce(${serverGroupVariants.enabled}, false)`,
        revision: serverVariants.revision,
        selection_weight: sql<number>`coalesce(${serverGroupVariants.selectionWeight}, 0)::int`,
        runtime_spec: serverVariants.runtimeSpec,
      })
      .from(serverInstances)
      .innerJoin(serverGroups, eq(serverGroups.id, serverInstances.groupId))
      .innerJoin(serverVariants, eq(serverVariants.id, serverInstances.variantId))
      .leftJoin(
        serverGroupVariants,
        and(
          eq(serverGroupVariants.groupId, serverInstances.groupId),
          eq(serverGroupVariants.variantId, serverInstances.variantId),
        ),
      )
      .where(eq(serverInstances.id, instanceId));
      
      const instance = instances[0];
      if (!instance) return null;

      const [players, cmdRows, eventRows, sessions] = await Promise.all([
        tx.select({
          player_id: instancePlayers.playerId,
          connected_at: instancePlayers.connectedAt,
          last_seen_at: instancePlayers.lastSeenAt,
        })
        .from(instancePlayers)
        .where(eq(instancePlayers.instanceId, instanceId))
        .orderBy(asc(instancePlayers.connectedAt)),
        
        tx.select({
          id: commands.id,
          operation: commands.operation,
          state: commands.state,
          attempts: commands.attempts,
          payload: commands.payload,
          last_error: commands.lastError,
          created_at: commands.createdAt,
          completed_at: commands.completedAt,
        })
        .from(commands)
        .where(eq(commands.instanceId, instanceId))
        .orderBy(desc(commands.createdAt))
        .limit(20),
        
        tx.select({
          id: events.id,
          type: events.type,
          payload: events.payload,
          created_at: events.createdAt,
        })
        .from(events)
        .where(and(
          eq(events.aggregateType, 'instance'),
          eq(events.aggregateId, instanceId)
        ))
        .orderBy(desc(events.createdAt))
        .limit(20),
        
        instance.session_id
          ? this.readSessionRows(tx, instance.session_id)
          : Promise.resolve([]),
      ]);

      return {
        schemaVersion: 3,
        generatedAt: new Date().toISOString(),
        activeDeadline: activeInstanceDeadline(instance as InstanceRow),
        instance: {
          ...toInstance(instance),
          groupId: instance.group_id,
          groupType: instance.group_type,
          containerId: instance.container_id,
          runtimePath: instance.runtime_path,
          stoppedAt: iso(instance.stopped_at),
        },
        variant: {
          id: instance.variant_id,
          enabled: instance.variant_enabled,
          revision: instance.revision,
          weight: instance.selection_weight,
          runtime: instance.runtime_spec as VariantRuntimeSpec,
          checksum: instance.checksum,
        },
        players: players.map((player) => ({
          playerId: player.player_id,
          connectedAt: requiredIso(player.connected_at),
          lastSeenAt: requiredIso(player.last_seen_at),
        })),
        session: sessions[0] ? toSession(sessions[0]) : null,
        commands: cmdRows.map((command) => ({
          id: command.id,
          operation: command.operation,
          state: command.state,
          attempts: command.attempts,
          payload: command.payload,
          lastError: command.last_error,
          createdAt: requiredIso(command.created_at),
          completedAt: iso(command.completed_at),
        })),
        events: eventRows.map((event) => ({
          id: event.id,
          type: event.type,
          payload: event.payload,
          createdAt: requiredIso(event.created_at),
        })),
      };
    });
  }

  public async getSession(sessionId: string): Promise<DashboardSessionDetail | null> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
      const sessions = await this.readSessionRows(tx, sessionId);
      const session = sessions[0];
      if (!session) return null;

      const [players, ticketRows, policyRows, transfers] = await Promise.all([
        tx.select({
          player_id: sessionPlayers.playerId,
          party_id: sessionPlayers.partyId,
          queue_entry_id: sessionPlayers.queueEntryId,
          state: sessionPlayers.state,
          selected_at: sessionPlayers.selectedAt,
          transferring_at: sessionPlayers.transferringAt,
          connected_at: sessionPlayers.connectedAt,
          left_at: sessionPlayers.leftAt,
        })
        .from(sessionPlayers)
        .where(eq(sessionPlayers.sessionId, sessionId))
        .orderBy(asc(sessionPlayers.partyId), asc(sessionPlayers.selectedAt), asc(sessionPlayers.playerId)),

        tx.select({
          id: queueEntries.id,
          party_id: queueEntries.partyId,
          transfer_started_at: queueEntries.transferStartedAt,
        })
        .from(queueEntries)
        .where(eq(queueEntries.sessionId, sessionId)),

        tx.select({
          team_count: serverGroups.teamCount,
          team_size: serverGroups.teamSize,
        })
        .from(serverGroups)
        .where(eq(serverGroups.id, session.group_id)),
        
        tx.select({
          id: transferCommands.id,
          instance_id: transferCommands.instanceId,
          state: transferCommands.state,
          attempts: transferCommands.attempts,
          next_attempt_at: transferCommands.nextAttemptAt,
          expires_at: transferCommands.expiresAt,
          created_at: transferCommands.createdAt,
          completed_at: transferCommands.completedAt,
        })
        .from(transferCommands)
        .where(eq(transferCommands.sessionId, sessionId))
        .orderBy(desc(transferCommands.createdAt))
        .limit(20),
      ]);

      const byTicket = new Map<string, {
        partyId: string;
        players: (DashboardSessionDetail["tickets"][number]["players"][number])[];
      }>();
      for (const player of players) {
        const ticketId = player.queue_entry_id ?? `legacy:${player.party_id}`;
        const ticket = byTicket.get(ticketId) ?? {
          partyId: player.party_id,
          players: [],
        };
        ticket.players.push({
          playerId: player.player_id,
          partyId: player.party_id,
          state: player.state,
          selectedAt: requiredIso(player.selected_at),
          transferringAt: iso(player.transferring_at),
          connectedAt: iso(player.connected_at),
          leftAt: iso(player.left_at),
        });
        byTicket.set(ticketId, ticket);
      }
      const policy = policyRows[0];
      const expectedSizes = [...byTicket.values()].map(
        (ticket) => ticket.players.filter((player) => player.state !== "LEFT").length,
      ).filter((size) => size > 0);
      const connectedSizes = [...byTicket.values()].map(
        (ticket) => ticket.players.filter((player) => player.state === "CONNECTED").length,
      ).filter((size) => size > 0);
      const expectedProfiles = computeFeasibleProfiles(
        expectedSizes,
        policy?.team_count ?? 1,
        policy?.team_size ?? 1,
      );
      const connectedProfiles = computeFeasibleProfiles(
        connectedSizes,
        policy?.team_count ?? 1,
        policy?.team_size ?? 1,
      );
      const transferByTicket = new Map(
        ticketRows.map((row) => [row.id, row.transfer_started_at]),
      );
      const generatedAt = new Date();
      return {
        schemaVersion: 2,
        generatedAt: generatedAt.toISOString(),
        activeDeadline: activeSessionDeadline(
          session,
          transfers,
        ),
        session: { ...toSession(session), groupId: session.group_id },
        tickets: [...byTicket.entries()]
          .map(([ticketId, ticket]) => ({
            ticketId,
            partyId: ticket.partyId,
            transferStartedAt: iso(transferByTicket.get(ticketId) ?? null),
            players: ticket.players,
          })),
        expectedProfiles,
        connectedProfiles,
        recommendedExpectedProfile: selectRecommendedProfile(expectedProfiles),
        recommendedConnectedProfile: selectRecommendedProfile(connectedProfiles),
        transfers: transfers.map((transfer) => ({
          id: transfer.id,
          instanceId: transfer.instance_id,
          state: transfer.state,
          attempts: transfer.attempts,
          nextAttemptAt: requiredIso(transfer.next_attempt_at),
          expiresAt: requiredIso(transfer.expires_at),
          createdAt: requiredIso(transfer.created_at),
          completedAt: iso(transfer.completed_at),
        })),
      };
    });
  }

  private async readClusterRows(
    tx: Extract<Parameters<Parameters<Database["transaction"]>[0]>[0], Function> | any,
  ): Promise<DashboardRows> {
    const hosts = await tx.select({
      id: executionHosts.id,
      control_url: executionHosts.controlUrl,
      game_address: executionHosts.gameAddress,
      health_state: executionHosts.healthState,
      admin_state: executionHosts.adminState,
      allocatable_cpu: executionHosts.allocatableCpu,
      reserved_cpu: sql<number>`COALESCE((
        SELECT sum(instance.reserved_cpu)
        FROM server_instances instance
        WHERE instance.host_id = ${executionHosts.id}
          AND instance.lifecycle_state <> 'STOPPED'
      ), 0)::float8`.mapWith(Number),
      allocatable_memory_bytes: executionHosts.allocatableMemoryBytes,
      reserved_memory_bytes: sql<number>`COALESCE((
        SELECT sum(instance.reserved_memory_bytes)
        FROM server_instances instance
        WHERE instance.host_id = ${executionHosts.id}
          AND instance.lifecycle_state <> 'STOPPED'
      ), 0)::float8`.mapWith(Number),
      active_instance_count: sql<number>`(
        SELECT count(*)::int
        FROM server_instances instance
        WHERE instance.host_id = ${executionHosts.id}
          AND instance.lifecycle_state IN ('CREATING', 'STARTING', 'RUNNING', 'DRAINING')
      )`.mapWith(Number),
      agent_version: executionHosts.agentVersion,
      last_heartbeat_at: executionHosts.lastHeartbeatAt,
      last_control_contact_at: executionHosts.lastControlContactAt,
      last_error: executionHosts.lastError,
    }).from(executionHosts).orderBy(asc(executionHosts.id));

    const groups = await tx.select({
      id: serverGroups.id,
      type: serverGroups.type,
      enabled: serverGroups.enabled,
      minimum_players: serverGroups.minimumPlayers,
      maximum_players: serverGroups.maximumPlayers,
      team_count: serverGroups.teamCount,
      team_size: serverGroups.teamSize,
      candidate_window: serverGroups.candidateWindow,
      instance_acquisition_timeout_ms: serverGroups.instanceAcquisitionTimeoutMs,
      lobby_stale_timeout_ms: serverGroups.lobbyStaleTimeoutMs,
      minimum_players_per_team: serverGroups.minimumPlayersPerTeam,
      maximum_team_spread: serverGroups.maximumTeamSpread,
      minimum_instances: serverGroups.minimumInstances,
      maximum_instances: serverGroups.maximumInstances,
      minimum_warm_instances: serverGroups.minimumWarmInstances,
      maximum_warm_instances: serverGroups.maximumWarmInstances,
      maximum_players_per_instance: serverGroups.maximumPlayersPerInstance,
      target_players_per_instance: serverGroups.targetPlayersPerInstance,
      startup_timeout_ms: serverGroups.startupTimeoutMs,
      drain_timeout_ms: serverGroups.drainTimeoutMs,
      cancelled_drain_timeout_ms: serverGroups.cancelledDrainTimeoutMs,
      shutdown_timeout_ms: serverGroups.shutdownTimeoutMs,
      transfer_timeout_ms: serverGroups.transferTimeoutMs,
      player_stale_timeout_ms: serverGroups.playerStaleTimeoutMs,
      instance_lifetime_ms: serverGroups.instanceLifetimeMs,
    })
    .from(serverGroups)
    .orderBy(asc(serverGroups.type), asc(serverGroups.id));

    const variants = await tx.select({
      id: serverVariants.id,
      group_id: serverGroupVariants.groupId,
      enabled: serverGroupVariants.enabled,
      revision: serverVariants.revision,
      selection_weight: serverGroupVariants.selectionWeight,
      runtime_spec: serverVariants.runtimeSpec,
    })
    .from(serverGroupVariants)
    .innerJoin(serverVariants, eq(serverVariants.id, serverGroupVariants.variantId))
    .orderBy(asc(serverGroupVariants.groupId), asc(serverVariants.id));

    const instances = await tx.select({
      id: serverInstances.id,
      host_id: serverInstances.hostId,
      group_id: serverInstances.groupId,
      variant_id: serverInstances.variantId,
      session_id: serverInstances.sessionId,
      lifecycle_state: serverInstances.lifecycleState,
      availability_state: serverInstances.availabilityState,
      endpoint: serverInstances.endpoint,
      player_count: serverInstances.playerCount,
      maximum_players: sql<number>`coalesce(${serverGroups.maximumPlayersPerInstance}, ${serverGroups.maximumPlayers}, 0)::int`,
      created_at: serverInstances.createdAt,
      starting_at: serverInstances.startingAt,
      startup_deadline: serverInstances.startupDeadline,
      running_at: serverInstances.runningAt,
      renewal_deadline: serverInstances.renewalDeadline,
      replaces_instance_id: serverInstances.replacesInstanceId,
      draining_at: serverInstances.drainingAt,
      drain_deadline: serverInstances.drainDeadline,
      drain_reason: serverInstances.drainReason,
      stopping_at: serverInstances.stoppingAt,
      shutdown_deadline: serverInstances.shutdownDeadline,
      updated_at: serverInstances.updatedAt,
    })
    .from(serverInstances)
    .innerJoin(serverGroups, eq(serverGroups.id, serverInstances.groupId))
    .where(ne(serverInstances.lifecycleState, 'STOPPED'))
    .orderBy(asc(serverInstances.groupId), asc(serverInstances.createdAt), asc(serverInstances.id));

    const sessions = await tx.select({
      id: gameSessions.id,
      group_id: gameSessions.groupId,
      instance_id: gameSessions.instanceId,
      state: gameSessions.state,
      assignment_revision: gameSessions.assignmentRevision,
      assignment_acknowledged_at: gameSessions.assignmentAcknowledgedAt,
      instance_acquisition_deadline: gameSessions.instanceAcquisitionDeadline,
      lobby_stale_deadline: gameSessions.lobbyStaleDeadline,
      retry_count: gameSessions.retryCount,
      maximum_player_count: sql<number>`coalesce(${serverGroups.maximumPlayers}, 0)::int`,
      active_player_count: sql<number>`count(${sessionPlayers.playerId}) FILTER (WHERE ${sessionPlayers.state} <> 'LEFT')::int`,
      connected_player_count: sql<number>`count(${sessionPlayers.playerId}) FILTER (WHERE ${sessionPlayers.state} = 'CONNECTED')::int`,
      team_count: serverGroups.teamCount,
      created_at: gameSessions.createdAt,
      started_at: gameSessions.startedAt,
      finished_at: gameSessions.finishedAt,
      updated_at: gameSessions.updatedAt,
    })
    .from(gameSessions)
    .innerJoin(serverGroups, eq(serverGroups.id, gameSessions.groupId))
    .leftJoin(sessionPlayers, eq(sessionPlayers.sessionId, gameSessions.id))
    .where(
      or(
        notInArray(gameSessions.state, ['FINISHED', 'CANCELLED', 'FAILED']),
        sql`EXISTS (
           SELECT 1 FROM server_instances i
           WHERE i.session_id = ${gameSessions.id} AND i.lifecycle_state <> 'STOPPED'
         )`
      )
    )
    .groupBy(gameSessions.id, serverGroups.id)
    .orderBy(asc(gameSessions.groupId), asc(gameSessions.createdAt), asc(gameSessions.id));

    const queues = await tx.select({
      group_id: queueEntries.groupId,
      party_count: sql<number>`count(DISTINCT ${queueEntries.id})::int`,
      player_count: sql<number>`count(${queueEntryPlayers.playerId})::int`,
      oldest_joined_at: sql<DatabaseTimestamp | null>`min(${queueEntries.joinedAt})`,
    })
    .from(queueEntries)
    .leftJoin(queueEntryPlayers, eq(queueEntryPlayers.queueEntryId, queueEntries.id))
    .where(eq(queueEntries.state, 'QUEUED'))
    .groupBy(queueEntries.groupId);

    return {
      hosts: hosts as HostRow[],
      groups: groups as GroupRow[], 
      variants: variants as unknown as VariantRow[], 
      instances: instances as InstanceRow[], 
      sessions: sessions as SessionRow[], 
      queues: queues as QueueSummaryRow[] 
    };
  }

  private async readSessionRows(
    tx: Extract<Parameters<Parameters<Database["transaction"]>[0]>[0], Function> | any,
    sessionId: string,
  ): Promise<SessionRow[]> {
    const sessions = await tx.select({
      id: gameSessions.id,
      group_id: gameSessions.groupId,
      instance_id: gameSessions.instanceId,
      state: gameSessions.state,
      assignment_revision: gameSessions.assignmentRevision,
      assignment_acknowledged_at: gameSessions.assignmentAcknowledgedAt,
      instance_acquisition_deadline: gameSessions.instanceAcquisitionDeadline,
      lobby_stale_deadline: gameSessions.lobbyStaleDeadline,
      retry_count: gameSessions.retryCount,
      maximum_player_count: sql<number>`coalesce(${serverGroups.maximumPlayers}, 0)::int`,
      active_player_count: sql<number>`count(${sessionPlayers.playerId}) FILTER (WHERE ${sessionPlayers.state} <> 'LEFT')::int`,
      connected_player_count: sql<number>`count(${sessionPlayers.playerId}) FILTER (WHERE ${sessionPlayers.state} = 'CONNECTED')::int`,
      team_count: serverGroups.teamCount,
      created_at: gameSessions.createdAt,
      started_at: gameSessions.startedAt,
      finished_at: gameSessions.finishedAt,
      updated_at: gameSessions.updatedAt,
    })
    .from(gameSessions)
    .innerJoin(serverGroups, eq(serverGroups.id, gameSessions.groupId))
    .leftJoin(sessionPlayers, eq(sessionPlayers.sessionId, gameSessions.id))
    .where(eq(gameSessions.id, sessionId))
    .groupBy(gameSessions.id, serverGroups.id);

    return sessions as SessionRow[];
  }
}
