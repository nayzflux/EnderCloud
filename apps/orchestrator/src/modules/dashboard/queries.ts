import type {
DashboardClusterSnapshot,
DashboardInstanceDetail,
DashboardQueueDetail,
DashboardSessionDetail,
DashboardVariantGraph
} from "@endercloud/contracts/dashboard";
import type {
VariantRuntimeSpec
} from "@endercloud/contracts/domain";
import { and,asc,desc,eq,inArray,ne,notInArray,or,sql } from "drizzle-orm";
import type { Database,Transaction } from "../../db/client.ts";
import {
commands,
events,
executionHosts,
gameSessions,
instancePlayers,
operationalIncidents,
queueEntries,
queueEntryPlayers,
serverGroups,
serverGroupVariants,
serverInstances,
serverVariantLayers,
serverVariants,
sessionPlayers,
templateLayers,
transferCommands,
variantStartStates,
} from "../../db/schema.ts";
import {
computeFeasibleProfiles,
selectRecommendedProfile,
} from "../../domain/matchmaking.ts";

import { activeInstanceDeadline,activeSessionDeadline,assembleClusterSnapshot,type DashboardRows,type DatabaseTimestamp,type GroupRow,type HostRow,type InstanceRow,iso,normalizeDashboardLimit,proxyProjection,type QueueSummaryRow,requiredIso,type SessionRow,toInstance,toSession,type VariantRow } from "./projection.ts";

export class DashboardService {
  public constructor(
    private readonly db: Database,
    private readonly startupRetryLimit = 5,
  ) {}

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
        startup_state: variantStartStates.state,
        startup_failure_count: variantStartStates.failureCount,
        startup_retry_limit: sql<number>`${this.startupRetryLimit}`,
        startup_next_retry_at: variantStartStates.nextRetryAt,
        startup_last_failure_at: variantStartStates.lastFailureAt,
        startup_last_failed_instance_id: variantStartStates.lastFailedInstanceId,
        startup_last_failure_reason: variantStartStates.lastFailureReason,
      })
        .from(serverGroupVariants)
        .innerJoin(serverVariants, eq(serverVariants.id, serverGroupVariants.variantId))
        .leftJoin(variantStartStates, and(
          eq(variantStartStates.groupId, serverGroupVariants.groupId),
          eq(variantStartStates.variantId, serverVariants.id),
          eq(variantStartStates.variantRevision, serverVariants.revision),
        ))
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
          startup: variant.startup_state ? {
            state: variant.startup_state,
            failureCount: variant.startup_failure_count ?? 0,
            retryLimit: variant.startup_retry_limit,
            nextRetryAt: iso(variant.startup_next_retry_at),
            lastFailureAt: iso(variant.startup_last_failure_at),
            lastFailedInstanceId: variant.startup_last_failed_instance_id,
            lastFailureReason: variant.startup_last_failure_reason,
          } : null,
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
        variant_revision: serverInstances.variantRevision,
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
        failed_at: serverInstances.failedAt,
        failure_reason: serverInstances.failureReason,
        failure_details: serverInstances.failureDetails,
        failure_log_tail: serverInstances.failureLogTail,
        runtime_retained: serverInstances.runtimeRetained,
        updated_at: serverInstances.updatedAt,
        
        group_type: serverGroups.type,
        ...proxyProjection,
        container_id: serverInstances.containerId,
        runtime_path: serverInstances.runtimePath,
        stopped_at: serverInstances.stoppedAt,
        checksum: serverVariants.checksum,
        variant_enabled: sql<boolean>`coalesce(${serverGroupVariants.enabled}, false)`,
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
          revision: instance.variant_revision,
          weight: instance.selection_weight,
          runtime: instance.runtime_spec as VariantRuntimeSpec,
          checksum: instance.checksum,
          startup: null,
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
    tx: Transaction,
  ): Promise<DashboardRows> {
    const hosts = await tx.select({
      id: executionHosts.id,
      control_url: executionHosts.controlUrl,
      game_address: executionHosts.gameAddress,
      health_state: executionHosts.healthState,
      admin_state: executionHosts.adminState,
      allocatable_cpu: executionHosts.allocatableCpu,
      reserved_cpu: sql<number>`COALESCE(
        sum(${serverInstances.reservedCpu}) FILTER (
          WHERE ${serverInstances.lifecycleState} <> 'STOPPED'
        ),
        0
      )::float8`.mapWith(Number),
      allocatable_memory_bytes: executionHosts.allocatableMemoryBytes,
      reserved_memory_bytes: sql<number>`COALESCE(
        sum(${serverInstances.reservedMemoryBytes}) FILTER (
          WHERE ${serverInstances.lifecycleState} <> 'STOPPED'
        ),
        0
      )::float8`.mapWith(Number),
      active_instance_count: sql<number>`count(${serverInstances.id}) FILTER (
        WHERE ${serverInstances.lifecycleState}
          IN ('CREATING', 'STARTING', 'RUNNING', 'DRAINING')
      )::int`.mapWith(Number),
      agent_version: executionHosts.agentVersion,
      last_heartbeat_at: executionHosts.lastHeartbeatAt,
      last_control_contact_at: executionHosts.lastControlContactAt,
      last_error: executionHosts.lastError,
    })
      .from(executionHosts)
      .leftJoin(serverInstances, eq(serverInstances.hostId, executionHosts.id))
      .groupBy(executionHosts.id)
      .orderBy(asc(executionHosts.id));

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
      startup_state: variantStartStates.state,
      startup_failure_count: variantStartStates.failureCount,
      startup_retry_limit: sql<number>`${this.startupRetryLimit}`,
      startup_next_retry_at: variantStartStates.nextRetryAt,
      startup_last_failure_at: variantStartStates.lastFailureAt,
      startup_last_failed_instance_id: variantStartStates.lastFailedInstanceId,
      startup_last_failure_reason: variantStartStates.lastFailureReason,
    })
    .from(serverGroupVariants)
    .innerJoin(serverVariants, eq(serverVariants.id, serverGroupVariants.variantId))
    .leftJoin(variantStartStates, and(
      eq(variantStartStates.groupId, serverGroupVariants.groupId),
      eq(variantStartStates.variantId, serverVariants.id),
      eq(variantStartStates.variantRevision, serverVariants.revision),
    ))
    .orderBy(asc(serverGroupVariants.groupId), asc(serverVariants.id));

    const instances = await tx.select({
      ...proxyProjection,
      group_type: serverGroups.type,
      id: serverInstances.id,
      host_id: serverInstances.hostId,
      group_id: serverInstances.groupId,
      variant_id: serverInstances.variantId,
      variant_revision: serverInstances.variantRevision,
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
      failed_at: serverInstances.failedAt,
      failure_reason: serverInstances.failureReason,
      failure_details: serverInstances.failureDetails,
      failure_log_tail: serverInstances.failureLogTail,
      runtime_retained: serverInstances.runtimeRetained,
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

    const incidentCounts = await tx.select({
      active: sql<number>`count(*) FILTER (
        WHERE ${operationalIncidents.state} = 'ACTIVE'
      )::int`.mapWith(Number),
      critical: sql<number>`count(*) FILTER (
        WHERE ${operationalIncidents.state} = 'ACTIVE'
          AND ${operationalIncidents.severity} = 'CRITICAL'
      )::int`.mapWith(Number),
    }).from(operationalIncidents);

    return {
      hosts: hosts as HostRow[],
      groups: groups as GroupRow[], 
      variants: variants as unknown as VariantRow[], 
      instances: instances as InstanceRow[], 
      sessions: sessions as SessionRow[], 
      queues: queues as QueueSummaryRow[],
      incidentSummary: {
        active: incidentCounts[0]?.active ?? 0,
        critical: incidentCounts[0]?.critical ?? 0,
      },
    };
  }

  private async readSessionRows(
    tx: Transaction,
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
