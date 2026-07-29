import type postgres from "postgres";
import type { Database } from "../db/client.ts";
import { sql, eq, ne, and, isNotNull, inArray, desc, asc, or, notInArray } from "drizzle-orm";
import {
  serverGroups,
  serverVariants,
  serverInstances,
  gameSessions,
  queueEntries,
  queueEntryPlayers,
  instancePlayers,
  commands,
  events,
  sessionPlayers,
  transferCommands,
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
} from "../domain/dashboard.ts";
import type {
  AvailabilityState,
  GroupType,
  LifecycleState,
  SessionPlayerState,
  SessionState,
  VariantRuntimeSpec,
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
  waiting_timeout_ms: number | null;
  candidate_window?: number | null;
  instance_wait_timeout_ms?: number | null;
  maximum_waiting_timeout_ms?: number | null;
  minimum_players_per_team?: number | null;
  maximum_team_spread?: number | null;
  minimum_instances: number;
  maximum_instances: number;
  minimum_warm_instances: number;
  maximum_warm_instances: number;
  maximum_players_per_instance: number | null;
  target_players_per_instance: number | null;
  startup_timeout_ms: number;
  draining_timeout_ms: number;
  shutdown_timeout_ms: number;
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
  running_at: DatabaseTimestamp | null;
  draining_at: DatabaseTimestamp | null;
  drain_deadline: DatabaseTimestamp | null;
  updated_at: DatabaseTimestamp;
}

export interface SessionRow {
  id: string;
  group_id: string;
  instance_id: string | null;
  state: SessionState;
  assignment_revision: number;
  assignment_acknowledged_at: DatabaseTimestamp | null;
  waiting_deadline: DatabaseTimestamp | null;
  maximum_waiting_deadline?: DatabaseTimestamp | null;
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
    variantId: row.variant_id,
    sessionId: row.session_id,
    lifecycleState: row.lifecycle_state,
    availabilityState: row.availability_state,
    endpoint: row.endpoint,
    playerCount: row.player_count,
    maximumPlayers: row.maximum_players,
    createdAt: requiredIso(row.created_at),
    startingAt: iso(row.starting_at),
    runningAt: iso(row.running_at),
    drainingAt: iso(row.draining_at),
    drainDeadline: iso(row.drain_deadline),
    updatedAt: requiredIso(row.updated_at),
  };
}

function toSession(row: SessionRow): DashboardSession {
  return {
    id: row.id,
    instanceId: row.instance_id,
    state: row.state,
    assignmentRevision: row.assignment_revision,
    assignmentAcknowledgedAt: iso(row.assignment_acknowledged_at),
    waitingDeadline: iso(row.waiting_deadline),
    maximumWaitingDeadline: iso(row.maximum_waiting_deadline ?? null),
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
        instance.lifecycleState !== "STOPPED" && instance.lifecycleState !== "FAILED",
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
      lifecycle: {
        startupTimeoutMs: group.startup_timeout_ms,
        drainingTimeoutMs: group.draining_timeout_ms,
        shutdownTimeoutMs: group.shutdown_timeout_ms,
      },
      matchmaking:
        group.type === "minigame" &&
        group.minimum_players !== null &&
        group.maximum_players !== null &&
        group.team_count !== null &&
        group.team_size !== null &&
        group.waiting_timeout_ms !== null
          ? {
              minimumPlayers: group.minimum_players,
              maximumPlayers: group.maximum_players,
              teamCount: group.team_count,
              teamSize: group.team_size,
              waitingTimeoutMs: group.waiting_timeout_ms,
              candidateWindow: group.candidate_window ?? 20,
              instanceWaitTimeoutMs:
                group.instance_wait_timeout_ms ?? group.waiting_timeout_ms,
              maximumWaitingTimeoutMs:
                group.maximum_waiting_timeout_ms ?? group.waiting_timeout_ms * 3,
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
    schemaVersion: 1,
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
        schemaVersion: 1,
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

  public async getInstance(instanceId: string): Promise<DashboardInstanceDetail | null> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
      
      const instances = await tx.select({
        id: serverInstances.id,
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
        running_at: serverInstances.runningAt,
        draining_at: serverInstances.drainingAt,
        drain_deadline: serverInstances.drainDeadline,
        updated_at: serverInstances.updatedAt,
        
        group_type: serverGroups.type,
        container_id: serverInstances.containerId,
        runtime_path: serverInstances.runtimePath,
        stopped_at: serverInstances.stoppedAt,
        checksum: serverVariants.checksum,
        variant_enabled: serverVariants.enabled,
        revision: serverVariants.revision,
        selection_weight: serverVariants.selectionWeight,
        runtime_spec: serverVariants.runtimeSpec,
      })
      .from(serverInstances)
      .innerJoin(serverGroups, eq(serverGroups.id, serverInstances.groupId))
      .innerJoin(serverVariants, eq(serverVariants.id, serverInstances.variantId))
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
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
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
      return {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
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
    const groups = await tx.select({
      id: serverGroups.id,
      type: serverGroups.type,
      enabled: serverGroups.enabled,
      minimum_players: serverGroups.minimumPlayers,
      maximum_players: serverGroups.maximumPlayers,
      team_count: serverGroups.teamCount,
      team_size: serverGroups.teamSize,
      waiting_timeout_ms: serverGroups.waitingTimeoutMs,
      candidate_window: serverGroups.candidateWindow,
      instance_wait_timeout_ms: serverGroups.instanceWaitTimeoutMs,
      maximum_waiting_timeout_ms: serverGroups.maximumWaitingTimeoutMs,
      minimum_players_per_team: serverGroups.minimumPlayersPerTeam,
      maximum_team_spread: serverGroups.maximumTeamSpread,
      minimum_instances: serverGroups.minimumInstances,
      maximum_instances: serverGroups.maximumInstances,
      minimum_warm_instances: serverGroups.minimumWarmInstances,
      maximum_warm_instances: serverGroups.maximumWarmInstances,
      maximum_players_per_instance: serverGroups.maximumPlayersPerInstance,
      target_players_per_instance: serverGroups.targetPlayersPerInstance,
      startup_timeout_ms: serverGroups.startupTimeoutMs,
      draining_timeout_ms: serverGroups.drainingTimeoutMs,
      shutdown_timeout_ms: serverGroups.shutdownTimeoutMs,
    })
    .from(serverGroups)
    .orderBy(asc(serverGroups.type), asc(serverGroups.id));

    const variants = await tx.select({
      id: serverVariants.id,
      group_id: serverVariants.groupId,
      enabled: serverVariants.enabled,
      revision: serverVariants.revision,
      selection_weight: serverVariants.selectionWeight,
      runtime_spec: serverVariants.runtimeSpec,
    })
    .from(serverVariants)
    .orderBy(asc(serverVariants.groupId), asc(serverVariants.id));

    const instances = await tx.select({
      id: serverInstances.id,
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
      running_at: serverInstances.runningAt,
      draining_at: serverInstances.drainingAt,
      drain_deadline: serverInstances.drainDeadline,
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
      waiting_deadline: gameSessions.waitingDeadline,
      maximum_waiting_deadline: gameSessions.maximumWaitingDeadline,
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
      waiting_deadline: gameSessions.waitingDeadline,
      maximum_waiting_deadline: gameSessions.maximumWaitingDeadline,
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
