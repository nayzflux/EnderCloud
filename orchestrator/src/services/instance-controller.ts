import type { AppConfig } from "../config.ts";
import type { Database } from "../db/client.ts";
import {
  serverInstances,
  commands,
  serverVariants,
  serverGroups,
  gameSessions,
  sessionPlayers,
  instancePlayers,
  events,
} from "../db/schema.ts";
import { eq, and, sql, desc, inArray, isNotNull } from "drizzle-orm";
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

interface CreateRow {
  id: string;
  group_id: string;
  variant_id: string;
  session_id: string | null;
  template_path: string;
  runtime_spec: VariantRuntimeSpec;
}

interface StopRow {
  id: string;
  variant_id: string;
  shutdown_timeout_ms: number;
}

export class InstanceController {
  public constructor(
    private readonly db: Database,
    private readonly executor: Executor,
    private readonly variants: VariantSelector,
    private readonly bus: RedisEventBus,
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

  // Create an unassigned warm instance for the requested server group.
  public async createWarm(groupId: string): Promise<string> {
    const variant = await this.variants.select(groupId);
    const instanceId = nanoid();
    // Track deletion separately so failed cleanup is visible and retryable.
    const commandId = nanoid();
    // Persist the desired instance and its command before touching Docker. This
    // makes creation recoverable if the orchestrator crashes between the two steps.
    await this.db.transaction(async (tx) => {
      await tx.insert(serverInstances).values({
        id: instanceId,
        groupId: groupId,
        variantId: variant.id,
        lifecycleState: "CREATING",
        availabilityState: "OPEN",
      });
      await tx.insert(commands).values({
        id: commandId,
        instanceId: instanceId,
        operation: "CREATE",
        state: "PENDING",
      });
    });
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
        group_id: serverInstances.groupId,
        variant_id: serverInstances.variantId,
        session_id: serverInstances.sessionId,
        template_path: serverVariants.templatePath,
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
      // Executor creation is idempotent: an existing managed container is reused
      // when reconciliation resumes a partially completed CREATE command.
      const created = await this.executor.createInstance({
        instanceId: row.id,
        groupId: row.group_id,
        variantId: row.variant_id,
        ...(row.session_id ? { sessionId: row.session_id } : {}),
        templatePath: row.template_path,
        runtime: row.runtime_spec,
        environment: {},
      });
      await this.db.transaction(async (tx) => {
        await tx
          .update(serverInstances)
          .set({
            lifecycleState: "STARTING",
            startingAt: sql`COALESCE(${serverInstances.startingAt}, now())`,
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
      await this.db.transaction(async (tx) => {
        await tx
          .update(serverInstances)
          .set({ lifecycleState: "FAILED", updatedAt: sql`now()` })
          .where(eq(serverInstances.id, instanceId));
        await tx
          .update(commands)
          .set({
            state: "FAILED",
            completedAt: sql`now()`,
            lastError: message,
          })
          .where(eq(commands.id, commandId));
      });
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
        break;
      case "PLAYER_LEFT":
        await this.playerLeft(instanceId, event.playerId, event.sessionId);
        break;
      case "HEARTBEAT":
        await this.heartbeat(instanceId, event.playerIds);
        break;
      case "GAME_STARTING":
        await this.setSessionState(instanceId, event.sessionId, "STARTING");
        break;
      case "GAME_STARTED":
        await this.setSessionState(instanceId, event.sessionId, "RUNNING");
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
      })) as unknown as ServerSnapshot[];
    if (rows[0]) {
      // Publish registration only for the transaction that actually performed STARTING -> RUNNING.
      await this.bus.publishRegistry("SERVER_REGISTERED", rows[0]);
      return;
    }
    // A repeated SERVER_READY is valid; distinguish idempotency from an invalid lifecycle.
    const current = await this.db
      .select({ lifecycle_state: serverInstances.lifecycleState })
      .from(serverInstances)
      .where(eq(serverInstances.id, instanceId));
    if (current[0]?.lifecycle_state !== "RUNNING") {
      throw new Error(`Instance ${instanceId} is unavailable`);
    }
  }

  // Remove an eligible instance from routing and start its drain deadline.
  public async beginDrain(instanceId: string): Promise<boolean> {
    const rows = await this.db
      .update(serverInstances)
      .set({
        lifecycleState: "DRAINING",
        drainingAt: sql`now()`,
        drainDeadline: sql`now() + (${serverGroups.drainingTimeoutMs} * interval '1 millisecond')`,
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
      return true;
    }
    return false;
  }

  // Converge a terminal instance to STOPPED and clean its runtime resources.
  public async stopAndDelete(instanceId: string): Promise<void> {
    const rows = await this.db
      .update(serverInstances)
      .set({
        lifecycleState: "STOPPING",
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
        shutdown_timeout_ms: serverGroups.shutdownTimeoutMs,
      }) as unknown as StopRow[];
    const row = rows[0];
    if (!row) return;
    const commandId = nanoid();
    await this.db.insert(commands).values({
      id: commandId,
      instanceId: instanceId,
      operation: "DELETE",
      state: "RUNNING",
    });
    try {
      // Give Minecraft its configured graceful shutdown window before forcing removal.
      await this.executor.stopInstance(instanceId, Math.ceil(row.shutdown_timeout_ms / 1_000));
      await this.executor.deleteInstance(instanceId);
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

  // Return the current versioned player assignment for a minigame instance.
  public async getAssignment(instanceId: string) {
    const sessions = await this.db
      .select({
        session_id: gameSessions.id,
        group_id: gameSessions.groupId,
        state: gameSessions.state,
        assignment_revision: gameSessions.assignmentRevision,
      })
      .from(gameSessions)
      .innerJoin(serverInstances, eq(serverInstances.sessionId, gameSessions.id))
      .where(eq(serverInstances.id, instanceId));
    const session = sessions[0];
    if (!session) return null;
    const players = await this.db
      .select({
        player_id: sessionPlayers.playerId,
        party_id: sessionPlayers.partyId,
        team_index: sessionPlayers.teamIndex,
        state: sessionPlayers.state,
      })
      .from(sessionPlayers)
      .where(eq(sessionPlayers.sessionId, session.session_id))
      .orderBy(sessionPlayers.teamIndex, sessionPlayers.selectedAt);
    return {
      sessionId: session.session_id,
      groupId: session.group_id,
      state: session.state,
      revision: session.assignment_revision,
      players: players.map((player) => ({
        playerId: player.player_id,
        partyId: player.party_id,
        teamIndex: player.team_index,
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
        })
        .onConflictDoUpdate({
          target: [instancePlayers.instanceId, instancePlayers.playerId],
          set: { lastSeenAt: sql`now()` },
        });
      await tx
        .update(serverInstances)
        .set({
          playerCount: sql`(SELECT count(*)::int FROM instance_players WHERE instance_id = ${instanceId})`,
          updatedAt: sql`now()`,
        })
        .where(eq(serverInstances.id, instanceId));
      if (effectiveSessionId) {
        await tx
          .update(sessionPlayers)
          .set({
            state: "CONNECTED",
            connectedAt: sql`COALESCE(${sessionPlayers.connectedAt}, now())`,
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
          );
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
        await tx
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
          );
      }
    });
  }

  // Reconcile the authoritative player list reported by the game server.
  private async heartbeat(instanceId: string, playerIds: readonly string[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      const effectiveSessionId = await this.validateEventSession(tx, instanceId);
      // Refresh every reported player before removing stale rows, making the heartbeat authoritative.
      for (const playerId of playerIds) {
        await tx
          .insert(instancePlayers)
          .values({
            instanceId: instanceId,
            playerId: playerId,
          })
          .onConflictDoUpdate({
            target: [instancePlayers.instanceId, instancePlayers.playerId],
            set: { lastSeenAt: sql`now()` },
          });
        if (effectiveSessionId) {
          await tx
            .update(sessionPlayers)
            .set({
              state: "CONNECTED",
              connectedAt: sql`COALESCE(${sessionPlayers.connectedAt}, now())`,
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
            );
        }
      }
      await tx
        .delete(instancePlayers)
        .where(
          and(
            eq(instancePlayers.instanceId, instanceId),
            sql`${instancePlayers.lastSeenAt} < now() - interval '30 seconds'`
          )
        );
      if (effectiveSessionId) {
        // Mirror heartbeat removals into session state so transfer completion can account for departures.
        await tx
          .update(sessionPlayers)
          .set({
            state: "LEFT",
            leftAt: sql`now()`,
          })
          .where(
            and(
              eq(sessionPlayers.sessionId, effectiveSessionId),
              eq(sessionPlayers.state, "CONNECTED"),
              sql`NOT EXISTS (
              SELECT 1
              FROM instance_players ip
              WHERE ip.instance_id = ${instanceId}
                AND ip.player_id = ${sessionPlayers.playerId}
            )`
            )
          );
      }
      await tx
        .update(serverInstances)
        .set({
          playerCount: sql`(SELECT count(*)::int FROM instance_players WHERE instance_id = ${instanceId})`,
          updatedAt: sql`now()`,
        })
        .where(eq(serverInstances.id, instanceId));
    });
  }

  // Apply only valid, idempotent game-driven session state transitions.
  private async setSessionState(
    instanceId: string,
    sessionId: string,
    state: "STARTING" | "RUNNING",
  ): Promise<void> {
    const rows = await this.db
      .update(gameSessions)
      .set({
        state: state,
        startedAt: sql`CASE WHEN ${state} = 'RUNNING' THEN COALESCE(${gameSessions.startedAt}, now()) ELSE ${gameSessions.startedAt} END`,
        updatedAt: sql`now()`,
      })
      .from(serverInstances)
      .where(
        and(
          eq(gameSessions.id, sessionId),
          eq(serverInstances.id, instanceId),
          eq(serverInstances.sessionId, gameSessions.id),
          eq(gameSessions.instanceId, serverInstances.id),
          sql`(
          (${state} = 'STARTING' AND ${gameSessions.state} IN ('TRANSFERRING', 'WAITING'))
          OR (${state} = 'RUNNING' AND ${gameSessions.state} = 'STARTING')
        )`
        )
      )
      .returning({ id: gameSessions.id });
    // The conditional UPDATE is the concurrency-safe transition path.
    if (rows.length > 0) return;
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
