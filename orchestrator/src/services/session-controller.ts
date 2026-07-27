import type { AppConfig } from "../config.ts";
import type { SqlClient } from "../db/client.ts";
import { shouldRetryFailedSession } from "../domain/session-recovery.ts";
import type { SessionState } from "../domain/types.ts";
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
}

export class SessionController {
  private running = false;

  public constructor(
    private readonly sql: SqlClient,
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
    await this.sql`
      UPDATE session_players sp
      SET state = 'LEFT', left_at = now()
      FROM game_sessions s
      WHERE sp.session_id = s.id
        AND s.state IN ('TRANSFERRING', 'WAITING')
        AND sp.state = 'TRANSFERRING'
        AND sp.transferring_at IS NOT NULL
        AND sp.transferring_at < now() - (
          ${this.config.transferTimeoutMs} * interval '1 millisecond'
        )
    `;
  }

  // Start, keep waiting, or cancel sessions based on arrivals and deadlines.
  private async advanceWaitingSessions(): Promise<void> {
    const sessions = await this.sql<SessionRow[]>`
      SELECT
        s.id, s.instance_id, s.state,
        g.minimum_players, g.maximum_players,
        count(sp.player_id) FILTER (WHERE sp.state <> 'LEFT')::int AS active_players,
        count(sp.player_id) FILTER (WHERE sp.state = 'CONNECTED')::int AS connected_players,
        s.waiting_deadline <= now() AS deadline_reached
      FROM game_sessions s
      JOIN server_groups g ON g.id = s.group_id
      LEFT JOIN session_players sp ON sp.session_id = s.id
      WHERE s.state IN ('WAITING_FOR_INSTANCE', 'TRANSFERRING', 'WAITING')
      GROUP BY s.id, g.id
    `;
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
      // Start immediately when full, or at the deadline once the minimum viable count arrived.
      if (
        session.connected_players >= session.maximum_players ||
        (session.deadline_reached &&
          session.connected_players >= session.minimum_players)
      ) {
        await this.sql`
          UPDATE game_sessions SET state = 'STARTING', updated_at = now()
          WHERE id = ${session.id} AND state IN ('TRANSFERRING', 'WAITING')
        `;
        await this.sql`
          UPDATE transfer_commands
          SET state = 'COMPLETED', completed_at = now()
          WHERE session_id = ${session.id} AND state = 'PENDING'
        `;
      } else if (
        // Below-minimum sessions cannot start safely after the waiting window closes.
        session.deadline_reached &&
        session.connected_players < session.minimum_players
      ) {
        this.logger.info(
          `Session ${session.id} deadline reached without minimum players: session CANCELLED`,
        );
        await this.cancel(session.id, session.instance_id);
      } else if (
        // Once every still-active selection arrived, the lobby is waiting on game start rather than transfers.
        session.state === "TRANSFERRING" &&
        session.active_players > 0 &&
        session.active_players === session.connected_players
      ) {
        await this.sql`
          UPDATE game_sessions SET state = 'WAITING', updated_at = now()
          WHERE id = ${session.id} AND state = 'TRANSFERRING'
        `;
      }
    }
  }

  // Retry safe pre-start failures or fail sessions that can no longer be reassigned.
  private async recoverFailedInstances(): Promise<void> {
    const failures = await this.sql<
      {
        session_id: string;
        instance_id: string;
        session_state: SessionState;
        retry_count: number;
        connected_players: number;
      }[]
    >`
      SELECT
        s.id AS session_id, i.id AS instance_id, s.state AS session_state,
        s.retry_count,
        count(sp.player_id) FILTER (WHERE sp.state = 'CONNECTED')::int AS connected_players
      FROM game_sessions s
      JOIN server_instances i ON i.id = s.instance_id
      LEFT JOIN session_players sp ON sp.session_id = s.id
      WHERE i.lifecycle_state = 'FAILED'
        AND s.state NOT IN ('FINISHED', 'CANCELLED', 'FAILED')
      GROUP BY s.id, i.id
    `;
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
        await this.sql.begin(async (transaction) => {
          await transaction`
            UPDATE game_sessions s
            SET state = 'WAITING_FOR_INSTANCE', instance_id = NULL,
                transfer_started_at = NULL,
                waiting_deadline = now() + (
                  g.waiting_timeout_ms * interval '1 millisecond'
                ),
                retry_count = retry_count + 1, updated_at = now()
            FROM server_groups g
            WHERE s.id = ${failure.session_id} AND g.id = s.group_id
          `;
          await transaction`
            UPDATE session_players
            SET state = 'SELECTED', transferring_at = NULL
            WHERE session_id = ${failure.session_id}
              AND state = 'TRANSFERRING'
          `;
        });
      } else {
        this.logger.warn("Failing session after active instance failure", {
          sessionId: failure.session_id,
          instanceId: failure.instance_id,
          state: failure.session_state,
          connectedPlayers: failure.connected_players,
        });
        await this.sql`
          UPDATE game_sessions SET state = 'FAILED', updated_at = now()
          WHERE id = ${failure.session_id}
        `;
        await this.transfers.cancelForInstance(failure.instance_id);
      }
      // Cleanup happens after the session is detached or failed, making retries safe.
      await this.instances.stopAndDelete(failure.instance_id);
    }
  }

  // Evacuate hubs when needed and delete instances whose drain is complete.
  private async finishDrainingInstances(): Promise<void> {
    const due = await this.sql<
      {
        id: string;
        group_id: string;
        type: "hub" | "minigame";
        player_count: number;
      }[]
    >`
      SELECT i.id, i.group_id, g.type, i.player_count
      FROM server_instances i
      JOIN server_groups g ON g.id = i.group_id
      WHERE i.lifecycle_state = 'DRAINING'
        AND (i.player_count = 0 OR i.drain_deadline <= now())
    `;
    // Drain candidates are already due; hubs require evacuation before deletion.
    for (const instance of due) {
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
      this.sql<{ player_id: string }[]>`
        SELECT player_id FROM instance_players WHERE instance_id = ${sourceInstanceId}
      `,
      this.sql<
        {
          id: string;
          endpoint: string;
          available: number;
        }[]
      >`
        SELECT i.id, i.endpoint,
               (g.maximum_players_per_instance - i.player_count)::int AS available
        FROM server_instances i
        JOIN server_groups g ON g.id = i.group_id
        WHERE i.group_id = ${groupId}
          AND i.id <> ${sourceInstanceId}
          AND i.lifecycle_state = 'RUNNING'
          AND i.availability_state = 'OPEN'
          AND i.player_count < g.maximum_players_per_instance
        -- Fill the emptiest hubs first to spread load; use age as a stable tie-breaker.
        ORDER BY i.player_count, i.running_at
      `,
    ]);
    let offset = 0;
    // Consume the player list in slices sized to each destination's free capacity.
    for (const target of targets) {
      const selected = players
        .slice(offset, offset + target.available)
        .map((player) => player.player_id);
      if (selected.length > 0) {
        await this.sql.begin(async (transaction) => {
          await this.transfers.enqueue(transaction, {
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
    await this.sql`
      UPDATE game_sessions SET state = 'CANCELLED', updated_at = now()
      WHERE id = ${sessionId}
        AND state IN ('WAITING_FOR_INSTANCE', 'TRANSFERRING', 'WAITING')
    `;
    await this.sql`
      UPDATE transfer_commands
      SET state = 'CANCELLED', completed_at = now()
      WHERE session_id = ${sessionId} AND state = 'PENDING'
    `;
    if (instanceId) await this.instances.beginDrain(instanceId);
  }
}
