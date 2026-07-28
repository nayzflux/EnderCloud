import type { AppConfig } from "../config.ts";
import type { Database } from "../db/client.ts";
import { sql, and, eq, inArray, isNotNull, lt, ne, notInArray } from "drizzle-orm";
import { gameSessions, instancePlayers, serverGroups, serverInstances, sessionPlayers, transferCommands } from "../db/schema.ts";
import { shouldRetryFailedSession } from "../domain/session-recovery.ts";
import type { SessionState } from "../domain/types.ts";
import {
  computeFeasibleProfiles,
  isSessionLockEligible,
  selectRecommendedProfile,
} from "../domain/matchmaking.ts";
import type { Logger } from "../logger.ts";
import type { InstanceController } from "./instance-controller.ts";
import type { TransferService } from "./transfer-service.ts";

interface SessionRow {
  id: string;
  instance_id: string | null;
  state: "WAITING_FOR_INSTANCE" | "TRANSFERRING" | "WAITING";
  minimum_players: number;
  maximum_players: number;
  active_players: number;
  connected_players: number;
  deadline_reached: boolean;
  maximum_deadline_reached: boolean;
  team_count: number;
  team_size: number;
  minimum_players_per_team: number;
  maximum_team_spread: number;
}

export class SessionController {
  private running = false;

  public constructor(
    private readonly db: Database,
    private readonly instances: InstanceController,
    private readonly transfers: TransferService,
    private readonly config: AppConfig,
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
        ["advance-waiting", () => this.advanceWaitingSessions()],
        ["recover-failed", () => this.recoverFailedInstances()],
        ["finish-draining", () => this.finishDrainingInstances()],
      ] as const;
      // Isolate stages so a failure in recovery does not block timeout or drain processing.
      for (const [stage, task] of stages) {
        try {
          await task();
        } catch (error) {
          this.logger.error("Session tick stage failed", {
            stage,
            error: String(error),
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
        isNotNull(sessionPlayers.transferringAt),
        lt(sessionPlayers.transferringAt, sql`now() - (${this.config.transferTimeoutMs} * interval '1 millisecond')`),
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
      minimum_players: serverGroups.minimumPlayers,
      maximum_players: serverGroups.maximumPlayers,
      active_players: sql<number>`count(${sessionPlayers.playerId}) FILTER (WHERE ${sessionPlayers.state} <> 'LEFT')::int`,
      connected_players: sql<number>`count(${sessionPlayers.playerId}) FILTER (WHERE ${sessionPlayers.state} = 'CONNECTED')::int`,
      deadline_reached: sql<boolean>`COALESCE(${gameSessions.waitingDeadline} <= now(), false)`,
      maximum_deadline_reached: sql<boolean>`COALESCE(${gameSessions.maximumWaitingDeadline} <= now(), false)`,
      team_count: serverGroups.teamCount,
      team_size: serverGroups.teamSize,
      minimum_players_per_team: serverGroups.minimumPlayersPerTeam,
      maximum_team_spread: serverGroups.maximumTeamSpread,
    })
    .from(gameSessions)
    .innerJoin(serverGroups, eq(serverGroups.id, gameSessions.groupId))
    .leftJoin(sessionPlayers, eq(sessionPlayers.sessionId, gameSessions.id))
    .where(inArray(gameSessions.state, ["WAITING_FOR_INSTANCE", "TRANSFERRING", "WAITING"]))
    .groupBy(gameSessions.id, serverGroups.id) as unknown as SessionRow[];
    // Evaluate each session from the same database snapshot of counts and deadline state.
    for (const session of sessions) {
      if (session.state === "WAITING_FOR_INSTANCE") {
        if (session.deadline_reached) {
          this.logger.info("Session timed out while waiting for an instance", {
            sessionId: session.id,
          });
          await this.cancel(session.id, null);
        }
        continue;
      }
      const lockEligible = await this.isConnectedProfileEligible(session);
      // Only the plugin may lock. The maximum lobby deadline cancels solely if no legal start exists.
      if (session.maximum_deadline_reached && !lockEligible) {
        this.logger.info("Session maximum lobby deadline reached without an eligible profile", {
          sessionId: session.id,
          connectedPlayers: session.connected_players,
        });
        await this.cancel(session.id, session.instance_id);
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

  private async isConnectedProfileEligible(session: SessionRow): Promise<boolean> {
    if (session.connected_players < session.minimum_players) return false;
    const rows = (await this.db.execute(sql`
      SELECT count(*)::integer AS size
      FROM session_players
      WHERE session_id = ${session.id} AND state = 'CONNECTED'
      GROUP BY COALESCE(queue_entry_id, 'legacy:' || party_id)
    `)) as unknown as { size: number }[];
    const profiles = computeFeasibleProfiles(
      rows.map((row) => Number(row.size)),
      session.team_count,
      session.team_size,
    );
    return isSessionLockEligible(
      session.connected_players,
      session.minimum_players,
      session.maximum_players,
      session.deadline_reached,
      selectRecommendedProfile(profiles),
      session.minimum_players_per_team,
      session.maximum_team_spread,
    );
  }

  // Retry safe pre-start failures or fail sessions that can no longer be reassigned.
  private async recoverFailedInstances(): Promise<void> {
    const failures = await this.db.select({
      session_id: gameSessions.id,
      instance_id: serverInstances.id,
      session_state: gameSessions.state,
      retry_count: gameSessions.retryCount,
      connected_players: sql<number>`count(${sessionPlayers.playerId}) FILTER (WHERE ${sessionPlayers.state} = 'CONNECTED')::int`,
    })
    .from(gameSessions)
    .innerJoin(serverInstances, eq(serverInstances.id, gameSessions.instanceId))
    .leftJoin(sessionPlayers, eq(sessionPlayers.sessionId, gameSessions.id))
    .where(and(
      eq(serverInstances.lifecycleState, "FAILED"),
      notInArray(gameSessions.state, ["FINISHED", "CANCELLED", "FAILED"])
    ))
    .groupBy(gameSessions.id, serverInstances.id) as unknown as 
      {
        session_id: string;
        instance_id: string;
        session_state: SessionState;
        retry_count: number;
        connected_players: number;
      }[];
    // Each failed instance owns at most one active session, so recover them independently.
    for (const failure of failures) {
      if (
        shouldRetryFailedSession(
          failure.session_state,
          failure.connected_players,
          failure.retry_count,
          this.config.maxInstanceRetries,
        )
      ) {
        this.logger.warn("Retrying session after pre-start instance failure", {
          sessionId: failure.session_id,
          instanceId: failure.instance_id,
          retry: failure.retry_count + 1,
        });
        await this.transfers.cancelForInstance(failure.instance_id);
        // Reset the session and its players atomically so no observer sees mixed retry state.
        await this.db.transaction(async (tx: any) => {
          await tx.update(gameSessions)
            .set({
              state: "WAITING_FOR_INSTANCE",
              instanceId: null,
              transferStartedAt: null,
              waitingDeadline: sql`now() + (
                (SELECT instance_wait_timeout_ms FROM server_groups WHERE id = ${gameSessions.groupId}) * interval '1 millisecond'
              )`,
              maximumWaitingDeadline: null,
              retryCount: sql`${gameSessions.retryCount} + 1`,
              updatedAt: sql`now()`
            })
            .where(eq(gameSessions.id, failure.session_id));
          await tx.update(sessionPlayers)
            .set({ state: "SELECTED", transferringAt: null })
            .where(and(
              eq(sessionPlayers.sessionId, failure.session_id),
              eq(sessionPlayers.state, "TRANSFERRING")
            ));
        });
      } else {
        this.logger.warn("Failing session after active instance failure", {
          sessionId: failure.session_id,
          instanceId: failure.instance_id,
          state: failure.session_state,
          connectedPlayers: failure.connected_players,
        });
        await this.db.update(gameSessions)
          .set({ state: "FAILED", updatedAt: sql`now()` })
          .where(eq(gameSessions.id, failure.session_id));
        await this.transfers.cancelForInstance(failure.instance_id);
      }
      // Cleanup happens after the session is detached or failed, making retries safe.
      await this.instances.stopAndDelete(failure.instance_id);
    }
  }

  // Actively evacuate cancelled minigames, then delete every drain that is complete.
  private async finishDrainingInstances(): Promise<void> {
    const draining = await this.db.select({
      id: serverInstances.id,
      group_id: serverInstances.groupId,
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
    .where(eq(serverInstances.lifecycleState, "DRAINING")) as unknown as
      {
        id: string;
        group_id: string;
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
        await this.evacuateHub(instance.id, instance.group_id);
      }
      await this.instances.stopAndDelete(instance.id);
    }
  }

  // Distribute remaining hub players across healthy instances with spare capacity.
  private async evacuateHub(
    sourceInstanceId: string,
    groupId: string,
  ): Promise<void> {
    const [players, targets] = await Promise.all([
      this.db.select({ player_id: instancePlayers.playerId })
        .from(instancePlayers)
        .where(eq(instancePlayers.instanceId, sourceInstanceId)) as unknown as { player_id: string }[],
      this.db.select({
        id: serverInstances.id,
        endpoint: serverInstances.endpoint,
        available: sql<number>`(${serverGroups.maximumPlayersPerInstance} - ${serverInstances.playerCount})::int`,
      })
      .from(serverInstances)
      .innerJoin(serverGroups, eq(serverGroups.id, serverInstances.groupId))
      .where(and(
        eq(serverInstances.groupId, groupId),
        ne(serverInstances.id, sourceInstanceId),
        eq(serverInstances.lifecycleState, "RUNNING"),
        eq(serverInstances.availabilityState, "OPEN"),
        sql`${serverInstances.playerCount} < ${serverGroups.maximumPlayersPerInstance}`
      ))
      .orderBy(serverInstances.playerCount, serverInstances.runningAt) as unknown as 
        {
          id: string;
          endpoint: string;
          available: number;
        }[]
      ,
    ]);
    let offset = 0;
    // Consume the player list in slices sized to each destination's free capacity.
    for (const target of targets) {
      const selected = players
        .slice(offset, offset + target.available)
        .map((player) => player.player_id);
      if (selected.length > 0) {
        await this.db.transaction(async (tx: any) => {
          await this.transfers.enqueue(tx, {
            instanceId: target.id,
            endpoint: target.endpoint,
            players: selected,
          });
        });
      }
      // Move the cursor by actual assignments, not advertised capacity, for the final partial slice.
      offset += selected.length;
      if (offset >= players.length) break;
    }
  }

  // Cancel a pre-start session, its transfers, and release its reserved instance.
  private async cancel(
    sessionId: string,
    instanceId: string | null,
  ): Promise<void> {
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
        .returning({ id: gameSessions.id });
      if (rows.length === 0) return false;
      await tx.update(transferCommands)
        .set({ state: "CANCELLED", completedAt: sql`now()` })
        .where(and(
          eq(transferCommands.sessionId, sessionId),
          eq(transferCommands.state, "PENDING")
        ));
      return true;
    });
    if (cancelled && instanceId) {
      await this.instances.beginDrain(
        instanceId,
        this.config.cancelledDrainTimeoutMs,
      );
    }
  }
}
