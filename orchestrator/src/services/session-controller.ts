import type { Database } from "../db/client.ts";
import { sql, and, eq, inArray, isNotNull, lt, notInArray, or } from "drizzle-orm";
import {
  gameSessions,
  instancePlayers,
  serverGroups,
  serverInstances,
  sessionPlayers,
  transferCommands,
} from "../db/schema.ts";
import type { SessionState } from "../domain/types.ts";
import type { Logger } from "../logger.ts";
import type { InstanceController } from "./instance-controller.ts";
import type { TransferService } from "./transfer-service.ts";
import type { HubRouter } from "./hub-router.ts";

interface SessionRow {
  id: string;
  instance_id: string | null;
  state: "WAITING_FOR_INSTANCE" | "TRANSFERRING" | "WAITING";
  active_players: number;
  connected_players: number;
  instance_acquisition_deadline_reached: boolean;
  lobby_stale_deadline_reached: boolean;
}

export class SessionController {
  private running = false;

  public constructor(
    private readonly db: Database,
    private readonly instances: InstanceController,
    private readonly transfers: TransferService,
    private readonly hubs: HubRouter,
    private readonly logger: Logger,
  ) {}

  // Advance timeout, recovery, and draining stages for all active sessions.
  public async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      // Stage order matters: expire stale players before deciding whether sessions may start,
      // then recover failures before final drain cleanup.
      const stages = [
        ["expire-transfers", () => this.expireTransfers()],
        ["expire-player-presence", () => this.expirePlayerPresence()],
        ["advance-waiting", () => this.advanceWaitingSessions()],
        ["recover-failed", () => this.recoverFailedInstances()],
        ["release-terminal-reservations", () => this.releaseTerminalReservations()],
        ["finish-draining", () => this.finishDrainingInstances()],
      ] as const;
      // Isolate stages so a failure in recovery does not block timeout or drain processing.
      for (const [stage, task] of stages) {
        try {
          await task();
        } catch (error) {
          this.logger.error("session.tick_stage.failed", "Session tick stage failed", {
            stage,
            error,
          });
        }
      }
    } finally {
      this.running = false;
    }
  }

  // Mark players as left when their transfer acknowledgement never arrives.
  private async expireTransfers(): Promise<void> {
    const changed = await this.db.update(sessionPlayers)
      .set({ state: "LEFT", leftAt: sql`now()` })
      .where(and(
        eq(sessionPlayers.state, "TRANSFERRING"),
        isNotNull(sessionPlayers.transferDeadline),
        lt(sessionPlayers.transferDeadline, sql`now()`),
        inArray(
          sessionPlayers.sessionId,
          this.db.select({ id: gameSessions.id })
            .from(gameSessions)
            .where(inArray(gameSessions.state, ["TRANSFERRING", "WAITING"]))
        )
      ))
      .returning({ sessionId: sessionPlayers.sessionId });
    for (const sessionId of new Set(changed.map((row) => row.sessionId))) {
      await this.db.update(gameSessions)
        .set({
          assignmentRevision: sql`${gameSessions.assignmentRevision} + 1`,
          assignmentAcknowledgedAt: null,
          updatedAt: sql`now()`,
        })
        .where(eq(gameSessions.id, sessionId));
    }
  }

  // Start, keep waiting, or cancel sessions based on arrivals and deadlines.
  private async advanceWaitingSessions(): Promise<void> {
    const sessions = await this.db.select({
      id: gameSessions.id,
      instance_id: gameSessions.instanceId,
      state: gameSessions.state,
      active_players: sql<number>`count(${sessionPlayers.playerId}) FILTER (WHERE ${sessionPlayers.state} <> 'LEFT')::int`,
      connected_players: sql<number>`count(${sessionPlayers.playerId}) FILTER (WHERE ${sessionPlayers.state} = 'CONNECTED')::int`,
      instance_acquisition_deadline_reached:
        sql<boolean>`COALESCE(${gameSessions.instanceAcquisitionDeadline} <= now(), false)`,
      lobby_stale_deadline_reached:
        sql<boolean>`COALESCE(${gameSessions.lobbyStaleDeadline} <= now(), false)`,
    })
    .from(gameSessions)
    .leftJoin(sessionPlayers, eq(sessionPlayers.sessionId, gameSessions.id))
    .where(inArray(gameSessions.state, ["WAITING_FOR_INSTANCE", "TRANSFERRING", "WAITING"]))
    .groupBy(gameSessions.id) as unknown as SessionRow[];
    // Evaluate each session from the same database snapshot of counts and deadline state.
    for (const session of sessions) {
      if (session.state === "WAITING_FOR_INSTANCE") {
        if (session.instance_acquisition_deadline_reached) {
          this.logger.info("session.instance_wait.expired", "Session timed out while waiting for an instance", {
            sessionId: session.id,
          });
          await this.cancel(session.id);
        }
        continue;
      }
      // Only the plugin decides whether a game may start. This is solely a
      // watchdog for a lobby that never progressed to GAME_STARTING.
      if (session.lobby_stale_deadline_reached) {
        this.logger.info("session.lobby_stale.expired", "Lobby stale deadline reached before game start", {
          sessionId: session.id,
          connectedPlayers: session.connected_players,
        });
        await this.cancel(session.id);
      } else if (
        // Once every still-active selection arrived, the lobby is waiting on game start rather than transfers.
        session.state === "TRANSFERRING" &&
        session.active_players > 0 &&
        session.active_players === session.connected_players
      ) {
        await this.db.update(gameSessions)
          .set({ state: "WAITING", updatedAt: sql`now()` })
          .where(and(
            eq(gameSessions.id, session.id),
            eq(gameSessions.state, "TRANSFERRING")
          ));
      }
    }
  }

  // Expire player observations independently of whichever instance heartbeats next.
  private async expirePlayerPresence(): Promise<void> {
    const expired = await this.db.select({
      instanceId: instancePlayers.instanceId,
      playerId: instancePlayers.playerId,
      sessionId: serverInstances.sessionId,
    })
      .from(instancePlayers)
      .innerJoin(serverInstances, eq(serverInstances.id, instancePlayers.instanceId))
      .where(lt(instancePlayers.staleDeadline, sql`now()`));
    for (const player of expired) {
      await this.db.transaction(async (tx: any) => {
        const removed = await tx.delete(instancePlayers)
          .where(and(
            eq(instancePlayers.instanceId, player.instanceId),
            eq(instancePlayers.playerId, player.playerId),
            lt(instancePlayers.staleDeadline, sql`now()`),
          ))
          .returning({ playerId: instancePlayers.playerId });
        if (removed.length === 0) return;
        await tx.update(serverInstances)
          .set({
            playerCount: sql`(
              SELECT count(*)::int FROM instance_players
              WHERE instance_id = ${player.instanceId}
            )`,
            updatedAt: sql`now()`,
          })
          .where(eq(serverInstances.id, player.instanceId));
        if (!player.sessionId) return;
        const changed = await tx.update(sessionPlayers)
          .set({ state: "LEFT", leftAt: sql`now()` })
          .where(and(
            eq(sessionPlayers.sessionId, player.sessionId),
            eq(sessionPlayers.playerId, player.playerId),
            eq(sessionPlayers.state, "CONNECTED"),
          ))
          .returning({ playerId: sessionPlayers.playerId });
        if (changed.length > 0) {
          await tx.update(gameSessions)
            .set({
              assignmentRevision: sql`${gameSessions.assignmentRevision} + 1`,
              assignmentAcknowledgedAt: null,
              updatedAt: sql`now()`,
            })
            .where(eq(gameSessions.id, player.sessionId));
        }
      });
    }
  }

  // Requeue safe pre-start failures or fail sessions that can no longer be reassigned.
  private async recoverFailedInstances(): Promise<void> {
    const failures = await this.db.select({ sessionId: gameSessions.id, instanceId: serverInstances.id })
      .from(gameSessions).innerJoin(serverInstances, eq(serverInstances.id, gameSessions.instanceId))
      .where(and(notInArray(gameSessions.state, ["FINISHED", "CANCELLED", "FAILED"]),
        or(eq(serverInstances.lifecycleState, "FAILED"), and(
          inArray(serverInstances.lifecycleState, ["STOPPING", "STOPPED"]), isNotNull(serverInstances.failureReason)))));
    for (const candidate of failures) {
      await this.db.transaction(async tx => {
        const [session] = await tx.select().from(gameSessions).where(eq(gameSessions.id, candidate.sessionId)).for("update");
        if (!session || session.instanceId !== candidate.instanceId ||
          ["FINISHED", "CANCELLED", "FAILED"].includes(session.state)) return;
        const [instance] = await tx.select().from(serverInstances).where(eq(serverInstances.id, candidate.instanceId));
        if (!instance || !(instance.lifecycleState === "FAILED" ||
          (instance.failureReason && ["STOPPING", "STOPPED"].includes(instance.lifecycleState)))) return;
        const players = await tx.select().from(sessionPlayers).where(eq(sessionPlayers.sessionId, session.id)).for("update");
        const preStart = ["FORMING", "WAITING_FOR_INSTANCE", "TRANSFERRING", "WAITING"].includes(session.state) &&
          !players.some(player => player.state === "CONNECTED");
        await tx.update(transferCommands).set({ state: "CANCELLED", completedAt: sql`now()` })
          .where(and(eq(transferCommands.instanceId, instance.id), eq(transferCommands.state, "PENDING")));
        const condition = and(eq(gameSessions.id, session.id), eq(gameSessions.instanceId, instance.id), eq(gameSessions.state, session.state));
        if (preStart) {
          await tx.update(gameSessions).set({ state: "WAITING_FOR_INSTANCE", instanceId: null,
            transferStartedAt: null, lobbyStaleDeadline: null,
            instanceAcquisitionDeadline: sql`COALESCE(${gameSessions.instanceAcquisitionDeadline}, now() + (
              SELECT instance_acquisition_timeout_ms FROM server_groups WHERE id = ${session.groupId}
            ) * interval '1 millisecond')`, updatedAt: sql`now()`,
          }).where(condition);
          await tx.update(sessionPlayers).set({ state: "SELECTED", transferringAt: null, transferDeadline: null })
            .where(and(eq(sessionPlayers.sessionId, session.id), eq(sessionPlayers.state, "TRANSFERRING")));
        } else {
          await tx.update(gameSessions).set({ state: "FAILED", updatedAt: sql`now()` }).where(condition);
        }
      });
    }
  }

  // Resume a drain when a crash occurred after the session became terminal.
  private async releaseTerminalReservations(): Promise<void> {
    const reserved = await this.db.select({
      instanceId: serverInstances.id,
      sessionState: gameSessions.state,
    })
      .from(serverInstances)
      .innerJoin(gameSessions, eq(gameSessions.id, serverInstances.sessionId))
      .where(and(
        eq(serverInstances.lifecycleState, "RUNNING"),
        eq(serverInstances.availabilityState, "RESERVED"),
        inArray(gameSessions.state, ["FINISHED", "CANCELLED", "FAILED"]),
      ));
    for (const instance of reserved) {
      await this.instances.beginDrain(
        instance.instanceId,
        instance.sessionState === "CANCELLED" ? "SESSION_CANCELLED" : "NORMAL",
      );
    }
  }

  // Actively evacuate cancelled minigames, then delete every drain that is complete.
  private async finishDrainingInstances(): Promise<void> {
    const draining = await this.db.select({
      id: serverInstances.id,
      type: serverGroups.type,
      player_count: serverInstances.playerCount,
      session_state: gameSessions.state,
      due: sql<boolean>`(
        ${serverInstances.playerCount} = 0
        OR ${serverInstances.drainDeadline} <= now()
      )`,
    })
    .from(serverInstances)
    .innerJoin(serverGroups, eq(serverGroups.id, serverInstances.groupId))
    .leftJoin(gameSessions, eq(gameSessions.id, serverInstances.sessionId))
    // Managed proxies are drained by Reconciler after their admission acknowledgement.
    .where(and(
      eq(serverInstances.lifecycleState, "DRAINING"),
      inArray(serverGroups.type, ["hub", "minigame"]),
    )) as unknown as
      {
        id: string;
        type: "hub" | "minigame";
        player_count: number;
        session_state: SessionState | null;
        due: boolean;
      }[];
    for (const instance of draining) {
      if (
        instance.type === "minigame" &&
        instance.session_state === "CANCELLED" &&
        instance.player_count > 0
      ) {
        await this.instances.evacuateCancelledMinigame(instance.id);
      }
      if (!instance.due) continue;
      if (instance.type === "hub" && instance.player_count > 0) {
        await this.evacuateHub(instance.id);
      }
      await this.instances.stopAndDelete(instance.id);
    }
  }

  // Distribute remaining hub players across healthy instances with spare capacity.
  private async evacuateHub(sourceInstanceId: string): Promise<void> {
    await this.hubs.transferConnectedPlayers(sourceInstanceId);
  }

  // Cancel a pre-start session, its transfers, and release its reserved instance.
  private async cancel(sessionId: string): Promise<void> {
    const cancelled = await this.db.transaction(async (tx: any) => {
      const rows = await tx.update(gameSessions)
        .set({
          state: "CANCELLED",
          finishedAt: sql`COALESCE(${gameSessions.finishedAt}, now())`,
          updatedAt: sql`now()`,
        })
        .where(and(
          eq(gameSessions.id, sessionId),
          inArray(gameSessions.state, ["FORMING", "WAITING_FOR_INSTANCE", "TRANSFERRING", "WAITING"])
        ))
        .returning({ instanceId: gameSessions.instanceId });
      if (rows.length === 0) return null;
      await tx.update(transferCommands)
        .set({ state: "CANCELLED", completedAt: sql`now()` })
        .where(and(
          eq(transferCommands.sessionId, sessionId),
          eq(transferCommands.state, "PENDING")
        ));
      return rows[0];
    });
    if (cancelled?.instanceId) {
      await this.instances.beginDrain(cancelled.instanceId, "SESSION_CANCELLED");
    }
  }
}
