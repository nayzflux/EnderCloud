import type { AppConfig } from "../config.ts";
import type { SqlClient } from "../db/client.ts";
import { shouldRetryFailedSession } from "../domain/session-recovery.ts";
import type { SessionState } from "../domain/types.ts";
import type { RedisEventBus } from "../events/redis-bus.ts";
import type { Logger } from "../logger.ts";
import type { InstanceController } from "./instance-controller.ts";

interface SessionRow {
  id: string;
  instance_id: string | null;
  state: "TRANSFERRING" | "WAITING";
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
    private readonly bus: RedisEventBus,
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

  public async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.expireTransfers();
      await this.advanceWaitingSessions();
      await this.recoverFailedInstances();
      await this.finishDrainingInstances();
    } catch (error) {
      this.logger.error("Session tick failed", { error: String(error) });
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
        AND sp.state IN ('SELECTED', 'TRANSFERRING')
        AND sp.selected_at < now() - (${this.config.transferTimeoutMs} * interval '1 millisecond')
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
      WHERE s.state IN ('TRANSFERRING', 'WAITING')
      GROUP BY s.id, g.id
    `;
    for (const session of sessions) {
      if (
        session.connected_players >= session.maximum_players ||
        (session.deadline_reached &&
          session.connected_players >= session.minimum_players)
      ) {
        await this.sql`
          UPDATE game_sessions SET state = 'STARTING', updated_at = now()
          WHERE id = ${session.id} AND state IN ('TRANSFERRING', 'WAITING')
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
        await this.sql`
          UPDATE game_sessions
          SET state = 'WAITING_FOR_INSTANCE', instance_id = NULL,
              retry_count = retry_count + 1, updated_at = now()
          WHERE id = ${failure.session_id}
        `;
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
        await this.bus.publishTransfer({
          instanceId: target.id,
          endpoint: target.endpoint,
          players: selected,
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
      WHERE id = ${sessionId} AND state IN ('TRANSFERRING', 'WAITING')
    `;
    if (instanceId) await this.instances.beginDrain(instanceId);
  }
}
