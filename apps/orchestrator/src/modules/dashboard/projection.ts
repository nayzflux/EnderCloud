import type {
ActiveDeadline,
DashboardClusterSnapshot,
DashboardGroup,
DashboardHost,
DashboardInstance,
DashboardQueueSummary,
DashboardSession,
DashboardVariant
} from "@endercloud/contracts/dashboard";
import type {
AvailabilityState,
ExecutionHostAdminState,
ExecutionHostHealthState,
GroupType,
LifecycleState,
SessionState,
VariantRuntimeSpec
} from "@endercloud/contracts/domain";

export type DatabaseTimestamp = Date | string;

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
  startup_state?: "BACKING_OFF" | "PROBING" | "BLOCKED" | "RESETTING" | null;
  startup_failure_count?: number | null;
  startup_retry_limit?: number;
  startup_next_retry_at?: DatabaseTimestamp | null;
  startup_last_failure_at?: DatabaseTimestamp | null;
  startup_last_failed_instance_id?: string | null;
  startup_last_failure_reason?: string | null;
}

export interface InstanceRow {
  group_type?: GroupType;
  proxy_last_seen_at?: DatabaseTimestamp | null;
  proxy_ready?: boolean;
  proxy_accepting_connections?: boolean;
  id: string;
  host_id?: string | null;
  group_id: string;
  variant_id: string;
  variant_revision?: number;
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
  failed_at?: DatabaseTimestamp | null;
  failure_reason?: string | null;
  failure_details?: Readonly<Record<string, unknown>> | null;
  failure_log_tail?: string | null;
  runtime_retained?: boolean;
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
  readonly incidentSummary?: {
    readonly active: number;
    readonly critical: number;
  };
}

export function requiredIso(value: DatabaseTimestamp): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}

export function iso(value: DatabaseTimestamp | null): string | null {
  return value === null ? null : requiredIso(value);
}

export function toVariant(row: VariantRow): DashboardVariant {
  return {
    id: row.id,
    enabled: row.enabled,
    revision: row.revision,
    weight: row.selection_weight,
    runtime: row.runtime_spec,
    startup: row.startup_state ? {
      state: row.startup_state,
      failureCount: row.startup_failure_count ?? 0,
      retryLimit: row.startup_retry_limit ?? 5,
      nextRetryAt: iso(row.startup_next_retry_at ?? null),
      lastFailureAt: iso(row.startup_last_failure_at ?? null),
      lastFailedInstanceId: row.startup_last_failed_instance_id ?? null,
      lastFailureReason: row.startup_last_failure_reason ?? null,
    } : null,
  };
}

export function toInstance(row: InstanceRow): DashboardInstance {
  return {
    ...(row.group_type === "proxy" ? { proxy: {
      lastHeartbeatAt: iso(row.proxy_last_seen_at ?? null),
      ready: row.proxy_ready ?? false,
      acceptingConnections: row.proxy_accepting_connections ?? false,
    } } : {}),
    id: row.id,
    hostId: row.host_id ?? null,
    variantId: row.variant_id,
    variantRevision: row.variant_revision ?? 1,
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
    failedAt: iso(row.failed_at ?? null),
    failureReason: row.failure_reason ?? null,
    failureDetails: row.failure_details ?? null,
    failureLogTail: row.failure_log_tail ?? null,
    runtimeRetained: row.runtime_retained ?? false,
    updatedAt: requiredIso(row.updated_at),
  };
}

export function toHost(row: HostRow): DashboardHost {
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

export function toSession(row: SessionRow): DashboardSession {
  return {
    id: row.id,
    instanceId: row.instance_id,
    state: row.state,
    assignmentRevision: row.assignment_revision,
    assignmentAcknowledgedAt: iso(row.assignment_acknowledged_at),
    instanceAcquisitionDeadline: iso(row.instance_acquisition_deadline),
    lobbyStaleDeadline: iso(row.lobby_stale_deadline ?? null),
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
    schemaVersion: 4,
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
      playersOnline: groups.filter((group) => group.type !== "proxy").flatMap((group) => group.instances).reduce(
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
      activeIncidentCount: rows.incidentSummary?.active ?? 0,
      criticalIncidentCount: rows.incidentSummary?.critical ?? 0,
    },
    hosts: (rows.hosts ?? []).map(toHost),
    groups,
  };
}

export function normalizeDashboardLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) return 50;
  return Math.max(1, Math.min(200, Math.trunc(value ?? 50)));
}

