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

  public async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const stages = [
        ["expire-transfers", () => this.expireTransfers()],
        ["advance-waiting", () => this.advanceWaitingSessions()],
        ["recover-failed", () => this.recoverFailedInstances()],
        ["finish-draining", () => this.finishDrainingInstances()],
      ] as const;
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
        session.deadline_reached &&
        session.connected_players < session.minimum_players
      ) {
        this.logger.info(
          `Session ${session.id} deadline reached without minimum players: session CANCELLED`,
        );
        await this.cancel(session.id, session.instance_id);
      } else if (
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
      await this.instances.stopAndDelete(failure.instance_id);
    }
  }

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
    for (const instance of due) {
      if (instance.type === "hub" && instance.player_count > 0) {
        await this.evacuateHub(instance.id, instance.group_id);
      }
      await this.instances.stopAndDelete(instance.id);
    }
  }

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
        ORDER BY i.player_count, i.running_at
      `,
    ]);
    let offset = 0;
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
      offset += selected.length;
      if (offset >= players.length) break;
    }
  }

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
