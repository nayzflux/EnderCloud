import { ApplicationError } from "@endercloud/contracts/errors";
import type {
PaperEvent
} from "@endercloud/contracts/domain";
import { nanoid } from "@endercloud/runtime/id";
import type { Logger } from "@endercloud/runtime/logger";
import { and,eq,inArray,sql } from "drizzle-orm";
import type { Database,Transaction } from "../../db/client.ts";
import {
events,
gameSessions,
instancePlayers,
serverGroups,
serverInstances,
sessionPlayers,
transferCommandPlayers,
transferCommands
} from "../../db/schema.ts";
import {
computeFeasibleProfiles,
isSessionLockEligible,
selectRecommendedProfile,
} from "../../domain/matchmaking.ts";
import type { MonitoringService } from "../monitoring/metrics.ts";
import type { HubRouter } from "../routing/hubs.ts";
import type { TransferService } from "../transfers/service.ts";

interface LifecycleCallbacks {
  evacuateCancelledMinigame(instanceId: string): Promise<number>;
  markReady(instanceId: string, endpoint?: string): Promise<void>;
  beginDrain(instanceId: string, reason?: "NORMAL" | "SESSION_CANCELLED" | "HUB_RENEWAL" | "HOST_MAINTENANCE"): Promise<boolean>;
  publishRoutingUpdate(instanceId: string): Promise<void>;
}

export class PaperEvents {
  public constructor(private readonly db: Database, private readonly transfers: TransferService,
    private readonly hubs: HubRouter, private readonly logger: Logger, private readonly monitoring: MonitoringService | undefined,
    private readonly paperHealthLeaseMs: number, private readonly lifecycle: LifecycleCallbacks) {}


  // Apply an event emitted by the Paper plugin and persist it for auditing.
  public async handlePaperEvent(instanceId: string, event: PaperEvent): Promise<void> {
    const [instance] = await this.db.select({ type: serverGroups.type })
      .from(serverInstances)
      .innerJoin(serverGroups, eq(serverGroups.id, serverInstances.groupId))
      .where(eq(serverInstances.id, instanceId));
    if (!instance || instance.type === "proxy") {
      throw new ApplicationError("CONFLICT", 409, `Paper instance ${instanceId} is unavailable`);
    }
    // Dispatch by protocol event so every event type has one state mutation path.
    switch (event.type) {
      case "SERVER_READY":
        await this.lifecycle.markReady(instanceId, event.endpoint);
        break;
      case "PLAYER_JOINED":
        await this.playerJoined(instanceId, event.playerId, event.sessionId);
        await this.lifecycle.publishRoutingUpdate(instanceId);
        break;
      case "PLAYER_LEFT":
        await this.playerLeft(instanceId, event.playerId, event.sessionId);
        await this.lifecycle.publishRoutingUpdate(instanceId);
        break;
      case "PLAYER_ELIMINATED":
        await this.playerEliminated(instanceId, event.playerId, event.sessionId);
        break;
      case "HEARTBEAT":
        await this.heartbeat(instanceId, event.playerIds);
        await this.monitoring?.recordTps(instanceId, event.tps);
        await this.lifecycle.publishRoutingUpdate(instanceId);
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
      await this.recordTransferArrival(tx, instanceId, playerId);
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
      const alive = await tx.update(serverInstances).set({
        paperHealthDeadline: new Date(Date.now() + this.paperHealthLeaseMs), healthSuspectedAt: null,
      }).where(and(eq(serverInstances.id, instanceId), inArray(serverInstances.lifecycleState, ["RUNNING", "DRAINING"])))
        .returning({ id: serverInstances.id });
      if (!alive.length) throw new ApplicationError("CONFLICT", 409, `Paper instance ${instanceId} is unavailable`);
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
        await this.recordTransferArrival(tx, instanceId, playerId);
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


  private async recordTransferArrival(
    tx: Transaction,
    instanceId: string,
    playerId: string,
  ): Promise<void> {
    await tx.update(transferCommandPlayers)
      .set({ state: "ARRIVED", observedAt: sql`now()` })
      .from(transferCommands)
      .where(and(
        eq(transferCommandPlayers.commandId, transferCommands.id),
        eq(transferCommands.instanceId, instanceId),
        eq(transferCommands.state, "PENDING"),
        eq(transferCommandPlayers.playerId, playerId),
        eq(transferCommandPlayers.state, "PENDING"),
      ));
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


  private async bumpAssignmentRevision(tx: Transaction, sessionId: string): Promise<void> {
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
    const transitioned = await this.db.transaction(async (tx: Transaction) => {
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
    const draining = await this.lifecycle.beginDrain(instanceId, "SESSION_CANCELLED");
    // A duplicate event may arrive after the lifecycle already entered DRAINING.
    if (!draining) await this.lifecycle.evacuateCancelledMinigame(instanceId);
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
    if (rows[0]?.instance_id) await this.lifecycle.beginDrain(rows[0].instance_id);
  }


  // Reject stale plugin events that refer to a different instance assignment.
  private async validateEventSession(
    tx: Transaction,
    instanceId: string,
    providedSessionId?: string,
  ): Promise<string | undefined> {
    const rows = await tx
      .select({ session_id: serverInstances.sessionId })
      .from(serverInstances)
      .where(eq(serverInstances.id, instanceId))
      .for("share");
    const instance = rows[0];
    if (!instance) {
      throw new ApplicationError("CONFLICT", 409, `Instance ${instanceId} is unavailable`);
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
        payload,
      });
  }
}
