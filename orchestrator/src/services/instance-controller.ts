import type { Database } from "../db/client.ts";
import {
  serverInstances,
  commands,
  serverVariantLayers,
  serverVariants,
  templateLayers,
  serverGroups,
  gameSessions,
  sessionPlayers,
  instancePlayers,
  events,
  transferCommands,
} from "../db/schema.ts";
import { asc, eq, and, sql, desc, inArray, isNotNull, notInArray } from "drizzle-orm";
import type postgres from "postgres";
import type {
  PaperEvent,
  ServerSnapshot,
  VariantRuntimeSpec,
} from "../domain/types.ts";
import type { RedisEventBus } from "../events/redis-bus.ts";
import type { Executor } from "../executor/executor.ts";
import type { Logger } from "../logger.ts";
import { nanoid } from "../id.ts";
import type { VariantSelector } from "./variant-selector.ts";
import {
  computeFeasibleProfiles,
  isSessionLockEligible,
  selectRecommendedProfile,
} from "../domain/matchmaking.ts";
import type { TransferService } from "./transfer-service.ts";
import type { HubRouter } from "./hub-router.ts";
import type { MonitoringService } from "./monitoring-service.ts";
import type { HostService } from "./host-service.ts";

interface CreateRow {
  id: string;
  host_id: string;
  group_id: string;
  variant_id: string;
  session_id: string | null;
  runtime_spec: VariantRuntimeSpec;
}

interface StopRow {
  id: string;
  host_id: string;
  shutdown_timeout_ms: number;
}

interface ReadyRow extends ServerSnapshot {
  readonly replacesInstanceId: string | null;
  readonly replacementReason: string | null;
}

export class InstanceController {
  public constructor(
    private readonly db: Database,
    private readonly executor: Executor,
    private readonly variants: VariantSelector,
    private readonly bus: RedisEventBus,
    private readonly transfers: TransferService,
    private readonly hubs: HubRouter,
    private readonly logger: Logger,
    private readonly monitoring?: MonitoringService,
    private readonly hosts?: HostService,
  ) {}

  // Move an instance into the shared failure path and remove it from proxy routing.
  public async failInstance(
    instanceId: string,
    reason: string,
    details: Readonly<Record<string, unknown>> = {},
  ): Promise<boolean> {
    const changed = await this.db.transaction(async (tx) => {
      const rows = await tx.update(serverInstances).set({
        lifecycleState: "FAILED",
        updatedAt: sql`now()`,
      }).where(and(
        eq(serverInstances.id, instanceId),
        inArray(serverInstances.lifecycleState, ["CREATING", "STARTING", "RUNNING", "DRAINING"]),
      )).returning({ id: serverInstances.id });
      if (rows.length === 0) return false;
      await tx.insert(events).values({
        id: nanoid(),
        aggregateType: "instance",
        aggregateId: instanceId,
        type: "INSTANCE_FAILED",
        payload: { reason, ...details },
      });
      return true;
    });
    if (changed) await this.bus.publishRegistry("SERVER_UNREGISTERED", { instanceId });
    return changed;
  }

  // Create an unassigned warm instance for the requested server group.
  public async createWarm(
    groupId: string,
    replacesInstanceId?: string,
    replacementReason: "HUB_RENEWAL" | "HOST_MAINTENANCE" = "HUB_RENEWAL",
  ): Promise<string | null> {
    const variant = await this.variants.select(groupId);
    const instanceId = nanoid();
    // Track deletion separately so failed cleanup is visible and retryable.
    const commandId = nanoid();
    // Persist the desired instance and its command before touching Docker. This
    // makes creation recoverable if the orchestrator crashes between the two steps.
    const persisted = await this.db.transaction(async (tx) => {
      const groups = await tx
        .select({
          enabled: serverGroups.enabled,
          maximum_instances: serverGroups.maximumInstances,
          type: serverGroups.type,
        })
        .from(serverGroups)
        .where(eq(serverGroups.id, groupId))
        .for("update");
      const group = groups[0];
      if (!group?.enabled) return false;

      const capacityLimit = group.maximum_instances +
        (replacesInstanceId && replacementReason === "HOST_MAINTENANCE" ? 1 : 0);

      let sourceHostId: string | undefined;
      if (replacesInstanceId) {
        const sourceConditions = [
          eq(serverInstances.id, replacesInstanceId),
          eq(serverInstances.groupId, groupId),
          eq(serverInstances.lifecycleState, "RUNNING"),
          eq(serverInstances.availabilityState, "OPEN"),
        ];
        if (replacementReason === "HUB_RENEWAL") {
          if (group.type !== "hub") return false;
          sourceConditions.push(sql`${serverInstances.renewalDeadline} <= now()`);
        } else {
          sourceConditions.push(sql`EXISTS (
            SELECT 1 FROM execution_hosts maintenance_host
            WHERE maintenance_host.id = ${serverInstances.hostId}
              AND maintenance_host.admin_state = 'DRAINING'
          )`);
        }
        const sources = await tx
          .select({ id: serverInstances.id, host_id: serverInstances.hostId })
          .from(serverInstances)
          .where(and(...sourceConditions));
        if (!sources[0]) return false;
        sourceHostId = sources[0].host_id ?? undefined;
        const activeReplacements = await tx
          .select({ id: serverInstances.id })
          .from(serverInstances)
          .where(
            and(
              eq(serverInstances.groupId, groupId),
              isNotNull(serverInstances.replacesInstanceId),
              inArray(serverInstances.lifecycleState, ["CREATING", "STARTING", "RUNNING"]),
              sql`EXISTS (
                SELECT 1
                FROM server_instances source
                WHERE source.id = ${serverInstances.replacesInstanceId}
                  AND source.lifecycle_state NOT IN ('STOPPED', 'FAILED')
              )`,
            ),
          )
          .limit(1);
        if (activeReplacements[0]) return false;
      }

      if (!this.hosts) throw new Error("Host service is required for instance placement");
      const placement = await this.hosts.selectForPlacement(
        tx,
        variant.runtime_spec,
        replacementReason === "HOST_MAINTENANCE" ? sourceHostId : undefined,
        { groupId, maximumInstances: capacityLimit },
      );
      if (placement.status === "BLOCKED") return false;
      const hostId = placement.hostId;

      await tx.insert(serverInstances).values({
        id: instanceId,
        groupId: groupId,
        variantId: variant.id,
        hostId,
        reservedCpu: variant.runtime_spec.cpu,
        reservedMemoryBytes: variant.runtime_spec.memoryBytes,
        lifecycleState: "CREATING",
        availabilityState: "OPEN",
        replacesInstanceId: replacesInstanceId ?? null,
        replacementReason: replacesInstanceId ? replacementReason : null,
      });
      await tx.insert(commands).values({
        id: commandId,
        instanceId: instanceId,
        operation: "CREATE",
        state: "PENDING",
      });
      return true;
    });
    if (!persisted) return null;
    await this.performCreate(instanceId, commandId);
    return instanceId;
  }

  // Resume an interrupted CREATE command from persisted state.
  public async resumeCreate(instanceId: string): Promise<void> {
    // Use the newest CREATE command because older attempts may describe an already-retried operation.
    const cmds = await this.db
      .select({ id: commands.id })
      .from(commands)
      .where(and(eq(commands.instanceId, instanceId), eq(commands.operation, "CREATE")))
      .orderBy(desc(commands.createdAt))
      .limit(1);
    const commandId = cmds[0]?.id ?? nanoid();
    if (cmds.length === 0) {
      await this.db.insert(commands).values({
        id: commandId,
        instanceId: instanceId,
        operation: "CREATE",
        state: "PENDING",
      });
    }
    await this.performCreate(instanceId, commandId);
  }

  // Execute the recoverable database-to-Docker creation workflow.
  private async performCreate(instanceId: string, commandId: string): Promise<void> {
    const rows = await this.db
      .select({
        id: serverInstances.id,
        host_id: serverInstances.hostId,
        group_id: serverInstances.groupId,
        variant_id: serverInstances.variantId,
        session_id: serverInstances.sessionId,
        runtime_spec: serverVariants.runtimeSpec,
      })
      .from(serverInstances)
      .innerJoin(serverVariants, eq(serverVariants.id, serverInstances.variantId))
      .where(
        and(
          eq(serverInstances.id, instanceId),
          inArray(serverInstances.lifecycleState, ["CREATING", "STARTING"])
        )
      );
    const row = rows[0] as unknown as CreateRow;
    if (!row) return;
    await this.db
      .update(commands)
      .set({ state: "RUNNING", attempts: sql`${commands.attempts} + 1` })
      .where(and(eq(commands.id, commandId), sql`${commands.state} <> 'SUCCEEDED'`));
    try {
      const templateLayersForVariant = await this.db
        .select({
          id: templateLayers.id,
          checksum: templateLayers.checksum,
        })
        .from(serverVariantLayers)
        .innerJoin(templateLayers, eq(templateLayers.id, serverVariantLayers.layerId))
        .where(eq(serverVariantLayers.variantId, row.variant_id))
        .orderBy(asc(serverVariantLayers.ordinal));
      if (templateLayersForVariant.length === 0) {
        throw new Error(`Variant ${row.variant_id} has no materialization layers`);
      }
      // Executor creation is idempotent: an existing managed container is reused
      // when reconciliation resumes a partially completed CREATE command.
      const created = await this.executor.createInstance({
        hostId: row.host_id,
        instanceId: row.id,
        groupId: row.group_id,
        variantId: row.variant_id,
        ...(row.session_id ? { sessionId: row.session_id } : {}),
        templateLayers: templateLayersForVariant,
        runtime: row.runtime_spec,
        environment: {},
      });
      await this.db.transaction(async (tx) => {
        await tx
          .update(serverInstances)
          .set({
            lifecycleState: "STARTING",
            startingAt: sql`COALESCE(${serverInstances.startingAt}, now())`,
            startupDeadline: sql`now() + (
              (SELECT startup_timeout_ms FROM server_groups WHERE id = ${row.group_id})
              * interval '1 millisecond'
            )`,
            containerId: created.containerId,
            runtimePath: created.runtimePath,
            endpoint: created.endpoint,
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(serverInstances.id, instanceId),
              inArray(serverInstances.lifecycleState, ["CREATING", "STARTING"])
            )
          );
        await tx
          .update(commands)
          .set({
            state: "SUCCEEDED",
            completedAt: sql`now()`,
            lastError: null,
          })
          .where(eq(commands.id, commandId));
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.db.update(commands).set({
        state: "FAILED",
        completedAt: sql`now()`,
        lastError: message,
      }).where(eq(commands.id, commandId));
      await this.failInstance(instanceId, "CREATE_FAILED", { error: message });
      this.logger.error("Instance creation failed", { instanceId, error: message });
    }
  }

  // Apply an event emitted by the Paper plugin and persist it for auditing.
  public async handlePaperEvent(instanceId: string, event: PaperEvent): Promise<void> {
    // Dispatch by protocol event so every event type has one state mutation path.
    switch (event.type) {
      case "SERVER_READY":
        await this.markReady(instanceId, event.endpoint);
        break;
      case "PLAYER_JOINED":
        await this.playerJoined(instanceId, event.playerId, event.sessionId);
        await this.publishRoutingUpdate(instanceId);
        break;
      case "PLAYER_LEFT":
        await this.playerLeft(instanceId, event.playerId, event.sessionId);
        await this.publishRoutingUpdate(instanceId);
        break;
      case "PLAYER_ELIMINATED":
        await this.playerEliminated(instanceId, event.playerId, event.sessionId);
        break;
      case "HEARTBEAT":
        await this.heartbeat(instanceId, event.playerIds);
        await this.monitoring?.recordTps(instanceId, event.tps);
        await this.publishRoutingUpdate(instanceId);
        break;
      case "GAME_STARTING":
        await this.setSessionState(instanceId, event.sessionId, "STARTING");
        break;
      case "GAME_STARTED":
        await this.setSessionState(instanceId, event.sessionId, "RUNNING");
        break;
      case "GAME_CANCELLED":
        await this.cancelSession(instanceId, event.sessionId, event.reason);
        break;
      case "GAME_FINISHED":
        await this.finishSession(instanceId, event.sessionId, event.results);
        break;
    }
    // Audit only after successful handling; rejected stale events must not look accepted.
    await this.recordEvent("instance", instanceId, event.type, event);
  }

  // Promote a starting instance to RUNNING and register it with proxies.
  public async markReady(instanceId: string, reportedEndpoint?: string): Promise<void> {
    const rows = (await this.db
      .update(serverInstances)
      .set({
        lifecycleState: "RUNNING",
        endpoint: sql`COALESCE(${reportedEndpoint ?? null}, ${serverInstances.endpoint})`,
        runningAt: sql`COALESCE(${serverInstances.runningAt}, now())`,
        renewalDeadline: sql`CASE
          WHEN ${serverGroups.type} = 'hub' THEN
            now() + (${serverGroups.instanceLifetimeMs} * interval '1 millisecond')
          ELSE NULL
        END`,
        updatedAt: sql`now()`,
      })
      .from(serverGroups)
      .where(
        and(
          eq(serverInstances.id, instanceId),
          eq(serverInstances.groupId, serverGroups.id),
          eq(serverInstances.lifecycleState, "STARTING")
        )
      )
      .returning({
        instanceId: serverInstances.id,
        variantId: serverInstances.variantId,
        groupId: serverInstances.groupId,
        groupType: serverGroups.type,
        endpoint: serverInstances.endpoint,
        lifecycleState: serverInstances.lifecycleState,
        availabilityState: serverInstances.availabilityState,
        playerCount: serverInstances.playerCount,
        maximumPlayers: sql<number>`COALESCE(${serverGroups.maximumPlayersPerInstance}, ${serverGroups.maximumPlayers}, 0)`,
        replacesInstanceId: serverInstances.replacesInstanceId,
        replacementReason: serverInstances.replacementReason,
      })) as unknown as ReadyRow[];
    if (rows[0]) {
      // Publish registration only for the transaction that actually performed STARTING -> RUNNING.
      await this.bus.publishRegistry("SERVER_REGISTERED", rows[0]);
      if (rows[0].replacesInstanceId) {
        await this.completeReplacement(instanceId);
      }
      return;
    }
    // A repeated SERVER_READY is valid; distinguish idempotency from an invalid lifecycle.
    const current = await this.db
      .select({
        lifecycle_state: serverInstances.lifecycleState,
        replaces_instance_id: serverInstances.replacesInstanceId,
      })
      .from(serverInstances)
      .where(eq(serverInstances.id, instanceId));
    if (current[0]?.lifecycle_state !== "RUNNING") {
      throw new Error(`Instance ${instanceId} is unavailable`);
    }
    if (current[0].replaces_instance_id) {
      await this.completeReplacement(instanceId);
    }
  }

  // Resume the durable handoff when a replacement became ready before the old hub drained.
  public async completeHubRenewal(replacementInstanceId: string): Promise<boolean> {
    return this.completeReplacement(replacementInstanceId);
  }

  public async completeReplacement(replacementInstanceId: string): Promise<boolean> {
    const replacements = (await this.db
      .select({
        instanceId: serverInstances.id,
        variantId: serverInstances.variantId,
        groupId: serverInstances.groupId,
        groupType: serverGroups.type,
        endpoint: serverInstances.endpoint,
        lifecycleState: serverInstances.lifecycleState,
        availabilityState: serverInstances.availabilityState,
        playerCount: serverInstances.playerCount,
        maximumPlayers: sql<number>`COALESCE(${serverGroups.maximumPlayersPerInstance}, 0)`,
        replacesInstanceId: serverInstances.replacesInstanceId,
        replacementReason: serverInstances.replacementReason,
      })
      .from(serverInstances)
      .innerJoin(serverGroups, eq(serverGroups.id, serverInstances.groupId))
      .where(
        and(
          eq(serverInstances.id, replacementInstanceId),
          eq(serverInstances.lifecycleState, "RUNNING"),
          isNotNull(serverInstances.endpoint),
          isNotNull(serverInstances.replacesInstanceId),
        ),
      )
      .limit(1)) as unknown as ReadyRow[];
    const replacement = replacements[0];
    if (!replacement?.replacesInstanceId) return false;

    const sources = await this.db
      .select({ id: serverInstances.id })
      .from(serverInstances)
      .where(
        and(
          eq(serverInstances.id, replacement.replacesInstanceId),
          eq(serverInstances.groupId, replacement.groupId),
          eq(serverInstances.lifecycleState, "RUNNING"),
        ),
      )
      .limit(1);
    if (!sources[0]) return false;

    // Re-registration is idempotent and closes the crash window between registration and drain.
    await this.bus.publishRegistry("SERVER_REGISTERED", replacement);
    return this.beginDrain(
      replacement.replacesInstanceId,
      replacement.replacementReason === "HOST_MAINTENANCE"
        ? "HOST_MAINTENANCE"
        : "HUB_RENEWAL",
    );
  }

  // Remove an eligible instance from routing and start its drain deadline.
  public async beginDrain(
    instanceId: string,
    reason: "NORMAL" | "SESSION_CANCELLED" | "HUB_RENEWAL" | "HOST_MAINTENANCE" = "NORMAL",
  ): Promise<boolean> {
    const rows = await this.db
      .update(serverInstances)
      .set({
        lifecycleState: "DRAINING",
        drainingAt: sql`now()`,
        drainReason: reason,
        drainDeadline: reason === "SESSION_CANCELLED"
          ? sql`now() + (${serverGroups.cancelledDrainTimeoutMs} * interval '1 millisecond')`
          : sql`now() + (${serverGroups.drainTimeoutMs} * interval '1 millisecond')`,
        updatedAt: sql`now()`,
      })
      .from(serverGroups)
      .where(
        and(
          eq(serverInstances.id, instanceId),
          eq(serverInstances.groupId, serverGroups.id),
          eq(serverInstances.lifecycleState, "RUNNING"),
          sql`(
          ${serverInstances.availabilityState} = 'OPEN'
          OR EXISTS (
            SELECT 1 FROM game_sessions s
            WHERE s.id = ${serverInstances.sessionId}
              AND s.state IN ('FINISHED', 'CANCELLED', 'FAILED')
          )
        )`
        )
      )
      .returning({ id: serverInstances.id });
    if (rows.length > 0) {
      // Remove routing before waiting for players to leave, preventing new joins during drain.
      await this.bus.publishRegistry("SERVER_UNREGISTERED", { instanceId });
      await this.evacuateCancelledMinigame(instanceId);
      return true;
    }
    return false;
  }

  // Actively move every player out of a cancelled minigame, retrying safely until it is empty.
  public async evacuateCancelledMinigame(sourceInstanceId: string): Promise<number> {
    const source = await this.db.select({ id: serverInstances.id })
      .from(serverInstances)
      .innerJoin(serverGroups, eq(serverGroups.id, serverInstances.groupId))
      .innerJoin(gameSessions, eq(gameSessions.id, serverInstances.sessionId))
      .where(and(
        eq(serverInstances.id, sourceInstanceId),
        eq(serverInstances.lifecycleState, "DRAINING"),
        eq(serverGroups.type, "minigame"),
        eq(gameSessions.state, "CANCELLED"),
      ))
      .limit(1);
    if (!source[0]) return 0;
    const result = await this.hubs.transferConnectedPlayers(
      sourceInstanceId,
      "SESSION_CANCELLED",
    );
    const moved = result.acceptedPlayers.length;
    if (moved > 0) {
      this.logger.info("Cancelled minigame evacuation scheduled", {
        instanceId: sourceInstanceId,
        playerCount: moved,
      });
    }
    return moved;
  }

  // Converge a terminal instance to STOPPED and clean its runtime resources.
  public async stopAndDelete(instanceId: string): Promise<void> {
    const rows = await this.db
      .update(serverInstances)
      .set({
        lifecycleState: "STOPPING",
        stoppingAt: sql`COALESCE(${serverInstances.stoppingAt}, now())`,
        shutdownDeadline:
          sql`now() + (${serverGroups.shutdownTimeoutMs} * interval '1 millisecond')`,
        updatedAt: sql`now()`,
      })
      .from(serverGroups)
      .where(
        and(
          eq(serverInstances.id, instanceId),
          eq(serverInstances.groupId, serverGroups.id),
          inArray(serverInstances.lifecycleState, ["DRAINING", "FAILED", "ORPHANED", "STOPPING"])
        )
      )
      .returning({
        id: serverInstances.id,
        host_id: serverInstances.hostId,
        shutdown_timeout_ms: serverGroups.shutdownTimeoutMs,
      }) as unknown as StopRow[];
    const row = rows[0];
    if (!row) return;
    if (!row.host_id) throw new Error(`Instance ${instanceId} has no execution host`);
    const commandId = nanoid();
    await this.db.insert(commands).values({
      id: commandId,
      instanceId: instanceId,
      operation: "DELETE",
      state: "RUNNING",
    });
    try {
      // Give Minecraft its configured graceful shutdown window before forcing removal.
      const target = { hostId: row.host_id, instanceId };
      await this.executor.stopInstance(target, Math.ceil(row.shutdown_timeout_ms / 1_000));
      await this.executor.deleteInstance(target);
      await this.db.transaction(async (tx) => {
        await tx
          .update(serverInstances)
          .set({
            lifecycleState: "STOPPED",
            stoppedAt: sql`now()`,
            containerId: null,
            runtimePath: null,
            updatedAt: sql`now()`,
          })
          .where(eq(serverInstances.id, instanceId));
        await tx
          .update(commands)
          .set({ state: "SUCCEEDED", completedAt: sql`now()` })
          .where(eq(commands.id, commandId));
      });
      await this.bus.publishRegistry("SERVER_UNREGISTERED", { instanceId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.db
        .update(commands)
        .set({ state: "FAILED", completedAt: sql`now()`, lastError: message })
        .where(eq(commands.id, commandId));
      this.logger.error("Instance deletion failed", { instanceId, error: message });
    }
  }

  // Return all running endpoints that may be registered by a proxy.
  public async listProxyServers(): Promise<readonly ServerSnapshot[]> {
    return (await this.db
      .select({
        instanceId: serverInstances.id,
        variantId: serverInstances.variantId,
        groupId: serverInstances.groupId,
        groupType: serverGroups.type,
        endpoint: serverInstances.endpoint,
        lifecycleState: serverInstances.lifecycleState,
        availabilityState: serverInstances.availabilityState,
        playerCount: serverInstances.playerCount,
        maximumPlayers: sql<number>`COALESCE(${serverGroups.maximumPlayersPerInstance}, ${serverGroups.maximumPlayers}, 0)`,
      })
      .from(serverInstances)
      .innerJoin(serverGroups, eq(serverGroups.id, serverInstances.groupId))
      .where(
        and(
          eq(serverInstances.lifecycleState, "RUNNING"),
          isNotNull(serverInstances.endpoint)
        )
      )
      .orderBy(serverInstances.runningAt, serverInstances.id)) as unknown as readonly ServerSnapshot[];
  }

  private async publishRoutingUpdate(instanceId: string): Promise<void> {
    const rows = (await this.db
      .select({
        instanceId: serverInstances.id,
        variantId: serverInstances.variantId,
        groupId: serverInstances.groupId,
        groupType: serverGroups.type,
        endpoint: serverInstances.endpoint,
        lifecycleState: serverInstances.lifecycleState,
        availabilityState: serverInstances.availabilityState,
        playerCount: serverInstances.playerCount,
        maximumPlayers: sql<number>`COALESCE(${serverGroups.maximumPlayersPerInstance}, ${serverGroups.maximumPlayers}, 0)`,
      })
      .from(serverInstances)
      .innerJoin(serverGroups, eq(serverGroups.id, serverInstances.groupId))
      .where(
        and(
          eq(serverInstances.id, instanceId),
          eq(serverInstances.lifecycleState, "RUNNING"),
          isNotNull(serverInstances.endpoint),
        ),
      )
      .limit(1)) as unknown as ServerSnapshot[];
    if (!rows[0]) return;
    try {
      await this.bus.publishRegistry("SERVER_UPDATED", rows[0]);
    } catch (error) {
      this.logger.warn("Unable to publish server load update", {
        instanceId,
        error: String(error),
      });
    }
  }

  // Return the current versioned player assignment for a minigame instance.
  public async getAssignment(instanceId: string) {
    const sessions = await this.db
      .select({
        session_id: gameSessions.id,
        group_id: gameSessions.groupId,
        state: gameSessions.state,
        assignment_revision: gameSessions.assignmentRevision,
        lobby_stale_deadline: gameSessions.lobbyStaleDeadline,
        minimum_players: serverGroups.minimumPlayers,
        maximum_players: serverGroups.maximumPlayers,
        team_count: serverGroups.teamCount,
        team_size: serverGroups.teamSize,
        minimum_players_per_team: serverGroups.minimumPlayersPerTeam,
        maximum_team_spread: serverGroups.maximumTeamSpread,
      })
      .from(gameSessions)
      .innerJoin(serverInstances, eq(serverInstances.sessionId, gameSessions.id))
      .innerJoin(serverGroups, eq(serverGroups.id, gameSessions.groupId))
      .where(eq(serverInstances.id, instanceId));
    const session = sessions[0];
    if (!session) return null;
    const players = await this.db
      .select({
        player_id: sessionPlayers.playerId,
        party_id: sessionPlayers.partyId,
        queue_entry_id: sessionPlayers.queueEntryId,
        state: sessionPlayers.state,
      })
      .from(sessionPlayers)
      .where(eq(sessionPlayers.sessionId, session.session_id))
      .orderBy(sessionPlayers.selectedAt, sessionPlayers.playerId);
    const connectedTicketSizes = new Map<string, number>();
    for (const player of players) {
      if (player.state === "CONNECTED") {
        connectedTicketSizes.set(
          player.queue_entry_id ?? `legacy:${player.party_id}`,
          (connectedTicketSizes.get(
            player.queue_entry_id ?? `legacy:${player.party_id}`,
          ) ?? 0) + 1,
        );
      }
    }
    const feasibleProfiles = computeFeasibleProfiles(
      [...connectedTicketSizes.values()],
      session.team_count ?? 1,
      session.team_size ?? 1,
    );
    const recommendedProfile = selectRecommendedProfile(feasibleProfiles);
    const expectedPlayerCount = players.filter((player) => player.state !== "LEFT").length;
    const connectedPlayerCount = players.filter((player) => player.state === "CONNECTED").length;
    const lockEligible = this.evaluateLockEligibility(
      connectedPlayerCount,
      recommendedProfile,
      session,
    );
    return {
      sessionId: session.session_id,
      groupId: session.group_id,
      state: session.state,
      revision: session.assignment_revision,
      expectedPlayerCount,
      connectedPlayerCount,
      acceptingTickets: ["FORMING", "WAITING_FOR_INSTANCE", "TRANSFERRING", "WAITING"]
        .includes(session.state) &&
        expectedPlayerCount < (session.maximum_players ?? Number.MAX_SAFE_INTEGER) &&
        (
          !session.lobby_stale_deadline ||
          session.lobby_stale_deadline.getTime() > Date.now()
        ),
      lockEligible,
      feasibleProfiles,
      recommendedProfile,
      players: players.map((player) => ({
        playerId: player.player_id,
        partyId: player.party_id,
        ticketId: player.queue_entry_id ?? `legacy:${player.party_id}`,
        state: player.state,
      })),
    };
  }

  // Record that the game server consumed the expected assignment revision.
  public async acknowledgeAssignment(instanceId: string, revision: number): Promise<boolean> {
    const rows = await this.db
      .update(gameSessions)
      .set({
        assignmentAcknowledgedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .from(serverInstances)
      .where(
        and(
          eq(serverInstances.id, instanceId),
          eq(serverInstances.sessionId, gameSessions.id),
          eq(gameSessions.assignmentRevision, revision)
        )
      )
      .returning({ id: gameSessions.id });
    return rows.length > 0;
  }

  // Atomically reflect a player arrival in both instance and session state.
  private async playerJoined(
    instanceId: string,
    playerId: string,
    sessionId?: string,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const effectiveSessionId = await this.validateEventSession(
        tx,
        instanceId,
        sessionId,
      );
      await tx
        .insert(instancePlayers)
        .values({
          instanceId: instanceId,
          playerId: playerId,
          staleDeadline: sql`now() + (
            SELECT player_stale_timeout_ms * interval '1 millisecond'
            FROM server_groups g
            JOIN server_instances i ON i.group_id = g.id
            WHERE i.id = ${instanceId}
          )`,
        })
        .onConflictDoUpdate({
          target: [instancePlayers.instanceId, instancePlayers.playerId],
          set: {
            lastSeenAt: sql`now()`,
            staleDeadline: sql`now() + (
              SELECT player_stale_timeout_ms * interval '1 millisecond'
              FROM server_groups g
              JOIN server_instances i ON i.group_id = g.id
              WHERE i.id = ${instanceId}
            )`,
          },
        });
      await tx
        .update(serverInstances)
        .set({
          playerCount: sql`(SELECT count(*)::int FROM instance_players WHERE instance_id = ${instanceId})`,
          updatedAt: sql`now()`,
        })
        .where(eq(serverInstances.id, instanceId));
      if (effectiveSessionId) {
        const changed = await tx
          .update(sessionPlayers)
          .set({
            state: "CONNECTED",
            connectedAt: sql`COALESCE(${sessionPlayers.connectedAt}, now())`,
            transferDeadline: null,
            leftAt: null,
          })
          .from(gameSessions)
          .where(
            and(
              eq(sessionPlayers.sessionId, effectiveSessionId),
              eq(sessionPlayers.playerId, playerId),
              eq(gameSessions.id, sessionPlayers.sessionId),
              inArray(gameSessions.state, ["TRANSFERRING", "WAITING"]),
              inArray(sessionPlayers.state, ["SELECTED", "TRANSFERRING", "LEFT"])
            )
          )
          .returning({ playerId: sessionPlayers.playerId });
        if (changed.length > 0) await this.bumpAssignmentRevision(tx, effectiveSessionId);
      }
    });
  }

  // Atomically remove a player from the instance and mark the session departure.
  private async playerLeft(
    instanceId: string,
    playerId: string,
    sessionId?: string,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const effectiveSessionId = await this.validateEventSession(
        tx,
        instanceId,
        sessionId,
      );
      // A grace window tolerates one delayed heartbeat before treating a player as absent.
      await tx
        .delete(instancePlayers)
        .where(
          and(
            eq(instancePlayers.instanceId, instanceId),
            eq(instancePlayers.playerId, playerId)
          )
        );
      await tx
        .update(serverInstances)
        .set({
          playerCount: sql`(SELECT count(*)::int FROM instance_players WHERE instance_id = ${instanceId})`,
          updatedAt: sql`now()`,
        })
        .where(eq(serverInstances.id, instanceId));
      if (effectiveSessionId) {
        const changed = await tx
          .update(sessionPlayers)
          .set({
            state: "LEFT",
            leftAt: sql`now()`,
          })
          .where(
            and(
              eq(sessionPlayers.sessionId, effectiveSessionId),
              eq(sessionPlayers.playerId, playerId),
              sql`${sessionPlayers.state} <> 'LEFT'`
            )
          )
          .returning({ playerId: sessionPlayers.playerId });
        if (changed.length > 0) await this.bumpAssignmentRevision(tx, effectiveSessionId);
      }
    });
  }

  // Release an eliminated player from a running session without disconnecting the spectator.
  private async playerEliminated(
    instanceId: string,
    playerId: string,
    sessionId: string,
  ): Promise<void> {
    const accepted = await this.db.transaction(async (tx) => {
      await this.validateEventSession(tx, instanceId, sessionId);
      const rows = await tx
        .select({
          sessionState: gameSessions.state,
          playerState: sessionPlayers.state,
        })
        .from(sessionPlayers)
        .innerJoin(gameSessions, eq(gameSessions.id, sessionPlayers.sessionId))
        .where(
          and(
            eq(sessionPlayers.sessionId, sessionId),
            eq(sessionPlayers.playerId, playerId),
          ),
        )
        .for("update", { of: sessionPlayers });
      const player = rows[0];
      if (!player) return false;
      if (player.sessionState !== "RUNNING") return false;
      if (player.playerState === "LEFT") return true;

      const changed = await tx
        .update(sessionPlayers)
        .set({ state: "LEFT", leftAt: sql`now()` })
        .where(
          and(
            eq(sessionPlayers.sessionId, sessionId),
            eq(sessionPlayers.playerId, playerId),
            sql`${sessionPlayers.state} <> 'LEFT'`,
          ),
        )
        .returning({ playerId: sessionPlayers.playerId });
      if (changed.length > 0) await this.bumpAssignmentRevision(tx, sessionId);
      return true;
    });
    if (!accepted) throw this.invalidSessionEvent(instanceId, sessionId);
  }

  // Reconcile the authoritative player list reported by the game server.
  private async heartbeat(instanceId: string, playerIds: readonly string[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      const effectiveSessionId = await this.validateEventSession(tx, instanceId);
      let assignmentChanged = false;
      // Refresh every reported player before removing stale rows, making the heartbeat authoritative.
      for (const playerId of playerIds) {
        await tx
          .insert(instancePlayers)
          .values({
            instanceId: instanceId,
            playerId: playerId,
            staleDeadline: sql`now() + (
              SELECT player_stale_timeout_ms * interval '1 millisecond'
              FROM server_groups g
              JOIN server_instances i ON i.group_id = g.id
              WHERE i.id = ${instanceId}
            )`,
          })
          .onConflictDoUpdate({
            target: [instancePlayers.instanceId, instancePlayers.playerId],
            set: {
              lastSeenAt: sql`now()`,
              staleDeadline: sql`now() + (
                SELECT player_stale_timeout_ms * interval '1 millisecond'
                FROM server_groups g
                JOIN server_instances i ON i.group_id = g.id
                WHERE i.id = ${instanceId}
              )`,
            },
          });
        if (effectiveSessionId) {
          const changed = await tx
            .update(sessionPlayers)
            .set({
              state: "CONNECTED",
              connectedAt: sql`COALESCE(${sessionPlayers.connectedAt}, now())`,
              transferDeadline: null,
              leftAt: null,
            })
            .from(gameSessions)
            .where(
              and(
                eq(sessionPlayers.sessionId, effectiveSessionId),
                eq(sessionPlayers.playerId, playerId),
                eq(gameSessions.id, sessionPlayers.sessionId),
                inArray(gameSessions.state, ["TRANSFERRING", "WAITING"]),
                inArray(sessionPlayers.state, ["SELECTED", "TRANSFERRING", "LEFT"])
              )
            )
            .returning({ playerId: sessionPlayers.playerId });
          assignmentChanged ||= changed.length > 0;
        }
      }
      await tx
        .update(serverInstances)
        .set({
          playerCount: sql`(SELECT count(*)::int FROM instance_players WHERE instance_id = ${instanceId})`,
          updatedAt: sql`now()`,
        })
        .where(eq(serverInstances.id, instanceId));
      if (effectiveSessionId && assignmentChanged) {
        await this.bumpAssignmentRevision(tx, effectiveSessionId);
      }
    });
  }

  // Apply only valid, idempotent game-driven session state transitions.
  private async setSessionState(
    instanceId: string,
    sessionId: string,
    state: "STARTING" | "RUNNING",
  ): Promise<void> {
    const transitioned = await this.db.transaction(async (tx) => {
      const current = await tx.select({
        state: gameSessions.state,
      })
        .from(gameSessions)
        .innerJoin(serverInstances, and(
          eq(serverInstances.id, gameSessions.instanceId),
          eq(serverInstances.sessionId, gameSessions.id),
        ))
        .where(and(eq(gameSessions.id, sessionId), eq(serverInstances.id, instanceId)))
        .for("update", { of: gameSessions });
      const session = current[0];
      if (!session) return false;
      if (session.state === state) return true;

      if (state === "STARTING") {
        if (!["TRANSFERRING", "WAITING"].includes(session.state)) return false;
        await tx.update(gameSessions)
          .set({ state: "STARTING", updatedAt: sql`now()` })
          .where(eq(gameSessions.id, sessionId));
        const removed = await tx.update(sessionPlayers)
          .set({ state: "LEFT", leftAt: sql`now()` })
          .where(and(
            eq(sessionPlayers.sessionId, sessionId),
            inArray(sessionPlayers.state, ["SELECTED", "TRANSFERRING"]),
          ))
          .returning({ playerId: sessionPlayers.playerId });
        if (removed.length > 0) {
          await this.bumpAssignmentRevision(tx, sessionId);
        }
        await tx.update(transferCommands)
          .set({ state: "CANCELLED", completedAt: sql`now()` })
          .where(and(
            eq(transferCommands.sessionId, sessionId),
            eq(transferCommands.state, "PENDING"),
          ));
        return true;
      }
      if (state === "RUNNING" && session.state === "STARTING") {
        await tx.update(gameSessions)
          .set({
            state: "RUNNING",
            startedAt: sql`COALESCE(${gameSessions.startedAt}, now())`,
            updatedAt: sql`now()`,
          })
          .where(eq(gameSessions.id, sessionId));
        return true;
      }
      return false;
    });
    if (transitioned) return;
    const current = await this.db
      .select({ state: gameSessions.state })
      .from(gameSessions)
      .innerJoin(
        serverInstances,
        and(
          eq(serverInstances.id, gameSessions.instanceId),
          eq(serverInstances.sessionId, gameSessions.id)
        )
      )
      .where(
        and(
          eq(gameSessions.id, sessionId),
          eq(serverInstances.id, instanceId)
        )
      );
    // Duplicate plugin events are idempotent, while skipped or foreign transitions are rejected.
    if (current[0]?.state === state) return;
    throw this.invalidSessionEvent(instanceId, sessionId);
  }

  private evaluateLockEligibility(
    connectedPlayerCount: number,
    recommendedProfile: readonly number[] | null,
    session: {
      minimum_players: number | null;
      maximum_players: number | null;
      minimum_players_per_team: number | null;
      maximum_team_spread: number | null;
      team_size: number | null;
    },
  ): boolean {
    return isSessionLockEligible(
      connectedPlayerCount,
      session.minimum_players ?? 1,
      session.maximum_players ?? Number.MAX_SAFE_INTEGER,
      recommendedProfile,
      session.minimum_players_per_team ?? 0,
      session.maximum_team_spread ?? session.team_size ?? 1,
    );
  }

  private async bumpAssignmentRevision(tx: any, sessionId: string): Promise<void> {
    await tx.update(gameSessions)
      .set({
        assignmentRevision: sql`${gameSessions.assignmentRevision} + 1`,
        assignmentAcknowledgedAt: null,
        updatedAt: sql`now()`,
      })
      .where(eq(gameSessions.id, sessionId));
  }

  // Accept an authoritative cancellation from the minigame and begin rapid evacuation.
  private async cancelSession(
    instanceId: string,
    sessionId: string,
    reason?: string,
  ): Promise<void> {
    const transitioned = await this.db.transaction(async (tx: any) => {
      const rows = await tx.update(gameSessions)
        .set({
          state: "CANCELLED",
          finishedAt: sql`COALESCE(${gameSessions.finishedAt}, now())`,
          updatedAt: sql`now()`,
        })
        .from(serverInstances)
        .where(and(
          eq(gameSessions.id, sessionId),
          eq(gameSessions.instanceId, instanceId),
          eq(serverInstances.id, instanceId),
          eq(serverInstances.sessionId, sessionId),
          inArray(gameSessions.state, [
            "TRANSFERRING",
            "WAITING",
            "STARTING",
            "RUNNING",
          ]),
        ))
        .returning({ id: gameSessions.id });
      if (rows.length === 0) return false;
      await tx.update(transferCommands)
        .set({ state: "CANCELLED", completedAt: sql`now()` })
        .where(and(
          eq(transferCommands.sessionId, sessionId),
          eq(transferCommands.state, "PENDING"),
        ));
      const removed = await tx.update(sessionPlayers)
        .set({ state: "LEFT", leftAt: sql`now()` })
        .where(and(
          eq(sessionPlayers.sessionId, sessionId),
          inArray(sessionPlayers.state, ["SELECTED", "TRANSFERRING"]),
        ))
        .returning({ playerId: sessionPlayers.playerId });
      if (removed.length > 0) await this.bumpAssignmentRevision(tx, sessionId);
      return true;
    });
    if (!transitioned) {
      const current = await this.db.select({ state: gameSessions.state })
        .from(gameSessions)
        .innerJoin(serverInstances, and(
          eq(serverInstances.id, gameSessions.instanceId),
          eq(serverInstances.sessionId, gameSessions.id),
        ))
        .where(and(
          eq(gameSessions.id, sessionId),
          eq(serverInstances.id, instanceId),
        ));
      if (current[0]?.state !== "CANCELLED") {
        throw this.invalidSessionEvent(instanceId, sessionId);
      }
    } else {
      await this.recordEvent("session", sessionId, "GAME_CANCELLED", {
        reason: reason ?? null,
      });
    }
    const draining = await this.beginDrain(instanceId, "SESSION_CANCELLED");
    // A duplicate event may arrive after the lifecycle already entered DRAINING.
    if (!draining) await this.evacuateCancelledMinigame(instanceId);
  }

  // Persist game completion results and drain the consumed instance.
  private async finishSession(
    instanceId: string,
    sessionId: string,
    results: unknown,
  ): Promise<void> {
    const rows = await this.db
      .update(gameSessions)
      .set({
        state: "FINISHED",
        finishedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .from(serverInstances)
      .where(
        and(
          eq(gameSessions.id, sessionId),
          eq(serverInstances.id, instanceId),
          eq(serverInstances.sessionId, gameSessions.id),
          eq(gameSessions.instanceId, serverInstances.id),
          inArray(gameSessions.state, ["STARTING", "RUNNING"])
        )
      )
      .returning({ instance_id: gameSessions.instanceId });
    if (rows.length === 0) {
      const current = await this.db
        .select({ state: gameSessions.state })
        .from(gameSessions)
        .innerJoin(
          serverInstances,
          and(
            eq(serverInstances.id, gameSessions.instanceId),
            eq(serverInstances.sessionId, gameSessions.id)
          )
        )
        .where(
          and(
            eq(gameSessions.id, sessionId),
            eq(serverInstances.id, instanceId)
          )
        );
      if (current[0]?.state === "FINISHED") return;
      throw this.invalidSessionEvent(instanceId, sessionId);
    }
    await this.recordEvent("session", sessionId, "GAME_RESULTS", results ?? {});
    if (rows[0]?.instance_id) await this.beginDrain(rows[0].instance_id);
  }

  // Reject stale plugin events that refer to a different instance assignment.
  private async validateEventSession(
    tx: Extract<Parameters<Parameters<Database["transaction"]>[0]>[0], Function> | any,
    instanceId: string,
    providedSessionId?: string,
  ): Promise<string | undefined> {
    const rows = await (tx as Database)
      .select({ session_id: serverInstances.sessionId })
      .from(serverInstances)
      .where(eq(serverInstances.id, instanceId))
      .for("share");
    const instance = rows[0];
    if (!instance) {
      throw new Error(`Instance ${instanceId} is unavailable`);
    }
    if (providedSessionId && providedSessionId !== instance.session_id) {
      throw this.invalidSessionEvent(instanceId, providedSessionId);
    }
    return instance.session_id ?? undefined;
  }

  private invalidSessionEvent(instanceId: string, sessionId: string): Error {
    return new Error(`Session ${sessionId} is unavailable for instance ${instanceId}`);
  }

  // Append an immutable domain event to the audit log.
  private async recordEvent(
    aggregateType: string,
    aggregateId: string,
    type: string,
    payload: unknown,
  ): Promise<void> {
    await this.db
      .insert(events)
      .values({
        id: nanoid(),
        aggregateType: aggregateType,
        aggregateId: aggregateId,
        type: type,
        payload: payload as any,
      });
  }
}
