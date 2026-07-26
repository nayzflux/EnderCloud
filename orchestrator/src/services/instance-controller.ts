import type { AppConfig } from "../config.ts";
import type { SqlClient } from "../db/client.ts";
import { jsonParameter } from "../db/json.ts";
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
    private readonly sql: SqlClient,
    private readonly executor: Executor,
    private readonly variants: VariantSelector,
    private readonly bus: RedisEventBus,
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

  public async createWarm(groupId: string): Promise<string> {
    const variant = await this.variants.select(groupId);
    const instanceId = nanoid();
    const commandId = nanoid();
    await this.sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO server_instances (
          id, group_id, variant_id, lifecycle_state, availability_state
        ) VALUES (
          ${instanceId}, ${groupId}, ${variant.id}, 'CREATING', 'OPEN'
        )
      `;
      await transaction`
        INSERT INTO commands (id, instance_id, operation, state)
        VALUES (${commandId}, ${instanceId}, 'CREATE', 'PENDING')
      `;
    });
    await this.performCreate(instanceId, commandId);
    return instanceId;
  }

  public async resumeCreate(instanceId: string): Promise<void> {
    const commands = await this.sql<{ id: string }[]>`
      SELECT id FROM commands
      WHERE instance_id = ${instanceId} AND operation = 'CREATE'
      ORDER BY created_at DESC LIMIT 1
    `;
    const commandId = commands[0]?.id ?? nanoid();
    if (commands.length === 0) {
      await this.sql`
        INSERT INTO commands (id, instance_id, operation, state)
        VALUES (${commandId}, ${instanceId}, 'CREATE', 'PENDING')
      `;
    }
    await this.performCreate(instanceId, commandId);
  }

  private async performCreate(instanceId: string, commandId: string): Promise<void> {
    const rows = await this.sql<CreateRow[]>`
      SELECT i.id, i.group_id, i.variant_id, i.session_id,
             v.template_path, v.runtime_spec
      FROM server_instances i
      JOIN server_variants v ON v.id = i.variant_id
      WHERE i.id = ${instanceId}
        AND i.lifecycle_state IN ('CREATING', 'STARTING')
    `;
    const row = rows[0];
    if (!row) return;
    await this.sql`
      UPDATE commands SET state = 'RUNNING', attempts = attempts + 1
      WHERE id = ${commandId} AND state <> 'SUCCEEDED'
    `;
    try {
      const created = await this.executor.createInstance({
        instanceId: row.id,
        groupId: row.group_id,
        variantId: row.variant_id,
        ...(row.session_id ? { sessionId: row.session_id } : {}),
        templatePath: row.template_path,
        runtime: row.runtime_spec,
        environment: {},
      });
      await this.sql.begin(async (transaction) => {
        await transaction`
          UPDATE server_instances
          SET lifecycle_state = 'STARTING',
              container_id = ${created.containerId},
              runtime_path = ${created.runtimePath},
              endpoint = ${created.endpoint},
              updated_at = now()
          WHERE id = ${instanceId} AND lifecycle_state IN ('CREATING', 'STARTING')
        `;
        await transaction`
          UPDATE commands
          SET state = 'SUCCEEDED', completed_at = now(), last_error = NULL
          WHERE id = ${commandId}
        `;
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.sql.begin(async (transaction) => {
        await transaction`
          UPDATE server_instances
          SET lifecycle_state = 'FAILED', updated_at = now()
          WHERE id = ${instanceId}
        `;
        await transaction`
          UPDATE commands
          SET state = 'FAILED', completed_at = now(), last_error = ${message}
          WHERE id = ${commandId}
        `;
      });
      this.logger.error("Instance creation failed", { instanceId, error: message });
    }
  }

  public async handlePaperEvent(instanceId: string, event: PaperEvent): Promise<void> {
    await this.recordEvent("instance", instanceId, event.type, event);
    switch (event.type) {
      case "SERVER_READY":
        await this.markReady(instanceId, event.endpoint);
        return;
      case "PLAYER_JOINED":
        await this.playerJoined(instanceId, event.playerId, event.sessionId);
        return;
      case "PLAYER_LEFT":
        await this.playerLeft(instanceId, event.playerId, event.sessionId);
        return;
      case "HEARTBEAT":
        await this.heartbeat(instanceId, event.playerIds);
        return;
      case "GAME_STARTING":
        await this.setSessionState(event.sessionId, "STARTING");
        return;
      case "GAME_STARTED":
        await this.setSessionState(event.sessionId, "RUNNING");
        return;
      case "GAME_FINISHED":
        await this.finishSession(event.sessionId, event.results);
        return;
    }
  }

  public async markReady(instanceId: string, reportedEndpoint?: string): Promise<void> {
    const rows = await this.sql<ServerSnapshot[]>`
      UPDATE server_instances i
      SET lifecycle_state = 'RUNNING',
          endpoint = COALESCE(${reportedEndpoint ?? null}, endpoint),
          running_at = COALESCE(running_at, now()),
          updated_at = now()
      FROM server_groups g
      WHERE i.id = ${instanceId}
        AND i.group_id = g.id
        AND i.lifecycle_state = 'STARTING'
      RETURNING
        i.id AS "instanceId", i.variant_id AS "variantId",
        i.group_id AS "groupId", g.type AS "groupType",
        i.endpoint, i.lifecycle_state AS "lifecycleState",
        i.availability_state AS "availabilityState",
        i.player_count AS "playerCount",
        COALESCE(g.maximum_players_per_instance, g.maximum_players, 0) AS "maximumPlayers"
    `;
    if (rows[0]) await this.bus.publishRegistry("SERVER_REGISTERED", rows[0]);
  }

  public async beginDrain(instanceId: string): Promise<boolean> {
    const rows = await this.sql<{ id: string }[]>`
      UPDATE server_instances i
      SET lifecycle_state = 'DRAINING',
          draining_at = now(),
          drain_deadline = now() + (g.draining_timeout_ms * interval '1 millisecond'),
          updated_at = now()
      FROM server_groups g
      WHERE i.id = ${instanceId}
        AND i.group_id = g.id
        AND i.lifecycle_state = 'RUNNING'
        AND (
          i.availability_state = 'OPEN'
          OR EXISTS (
            SELECT 1 FROM game_sessions s
            WHERE s.id = i.session_id
              AND s.state IN ('FINISHED', 'CANCELLED', 'FAILED')
          )
        )
      RETURNING i.id
    `;
    if (rows.length > 0) {
      await this.bus.publishRegistry("SERVER_UNREGISTERED", { instanceId });
      return true;
    }
    return false;
  }

  public async stopAndDelete(instanceId: string): Promise<void> {
    const rows = await this.sql<StopRow[]>`
      UPDATE server_instances i
      SET lifecycle_state = 'STOPPING', updated_at = now()
      FROM server_groups g
      WHERE i.id = ${instanceId}
        AND i.group_id = g.id
        AND i.lifecycle_state IN ('DRAINING', 'FAILED', 'ORPHANED', 'STOPPING')
      RETURNING i.id, g.shutdown_timeout_ms
    `;
    const row = rows[0];
    if (!row) return;
    const commandId = nanoid();
    await this.sql`
      INSERT INTO commands (id, instance_id, operation, state)
      VALUES (${commandId}, ${instanceId}, 'DELETE', 'RUNNING')
    `;
    try {
      await this.executor.stopInstance(instanceId, Math.ceil(row.shutdown_timeout_ms / 1_000));
      await this.executor.deleteInstance(instanceId);
      await this.sql.begin(async (transaction) => {
        await transaction`
          UPDATE server_instances
          SET lifecycle_state = 'STOPPED', stopped_at = now(),
              container_id = NULL, runtime_path = NULL, updated_at = now()
          WHERE id = ${instanceId}
        `;
        await transaction`
          UPDATE commands SET state = 'SUCCEEDED', completed_at = now()
          WHERE id = ${commandId}
        `;
      });
      await this.bus.publishRegistry("SERVER_UNREGISTERED", { instanceId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.sql`
        UPDATE commands SET state = 'FAILED', completed_at = now(), last_error = ${message}
        WHERE id = ${commandId}
      `;
      this.logger.error("Instance deletion failed", { instanceId, error: message });
    }
  }

  public async listProxyServers(): Promise<readonly ServerSnapshot[]> {
    return this.sql<ServerSnapshot[]>`
      SELECT
        i.id AS "instanceId", i.variant_id AS "variantId",
        i.group_id AS "groupId", g.type AS "groupType",
        i.endpoint, i.lifecycle_state AS "lifecycleState",
        i.availability_state AS "availabilityState",
        i.player_count AS "playerCount",
        COALESCE(g.maximum_players_per_instance, g.maximum_players, 0) AS "maximumPlayers"
      FROM server_instances i
      JOIN server_groups g ON g.id = i.group_id
      WHERE i.lifecycle_state = 'RUNNING' AND i.endpoint IS NOT NULL
      ORDER BY i.running_at, i.id
    `;
  }

  public async getAssignment(instanceId: string) {
    const sessions = await this.sql<{
      session_id: string;
      group_id: string;
      state: string;
      assignment_revision: number;
    }[]>`
      SELECT s.id AS session_id, s.group_id, s.state, s.assignment_revision
      FROM game_sessions s
      JOIN server_instances i ON i.session_id = s.id
      WHERE i.id = ${instanceId}
    `;
    const session = sessions[0];
    if (!session) return null;
    const players = await this.sql<{
      player_id: string;
      party_id: string;
      team_index: number;
      state: string;
    }[]>`
      SELECT player_id, party_id, team_index, state
      FROM session_players WHERE session_id = ${session.session_id}
      ORDER BY team_index, selected_at
    `;
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

  public async acknowledgeAssignment(instanceId: string, revision: number): Promise<boolean> {
    const rows = await this.sql<{ id: string }[]>`
      UPDATE game_sessions s
      SET assignment_acknowledged_at = now(), updated_at = now()
      FROM server_instances i
      WHERE i.id = ${instanceId}
        AND i.session_id = s.id
        AND s.assignment_revision = ${revision}
      RETURNING s.id
    `;
    return rows.length > 0;
  }

  private async playerJoined(
    instanceId: string,
    playerId: string,
    sessionId?: string,
  ): Promise<void> {
    await this.sql.begin(async (transaction) => {
      const instanceSessions = await transaction<{ session_id: string | null }[]>`
        SELECT session_id FROM server_instances WHERE id = ${instanceId}
      `;
      const effectiveSessionId = sessionId ?? instanceSessions[0]?.session_id ?? undefined;
      await transaction`
        INSERT INTO instance_players (instance_id, player_id)
        VALUES (${instanceId}, ${playerId})
        ON CONFLICT (instance_id, player_id)
        DO UPDATE SET last_seen_at = now()
      `;
      await transaction`
        UPDATE server_instances
        SET player_count = (
          SELECT count(*)::int FROM instance_players WHERE instance_id = ${instanceId}
        ), updated_at = now()
        WHERE id = ${instanceId}
      `;
      if (effectiveSessionId) {
        await transaction`
          UPDATE session_players
          SET state = 'CONNECTED', connected_at = COALESCE(connected_at, now())
          WHERE session_id = ${effectiveSessionId} AND player_id = ${playerId}
            AND state IN ('SELECTED', 'TRANSFERRING')
        `;
      }
    });
  }

  private async playerLeft(
    instanceId: string,
    playerId: string,
    sessionId?: string,
  ): Promise<void> {
    await this.sql.begin(async (transaction) => {
      const instanceSessions = await transaction<{ session_id: string | null }[]>`
        SELECT session_id FROM server_instances WHERE id = ${instanceId}
      `;
      const effectiveSessionId = sessionId ?? instanceSessions[0]?.session_id ?? undefined;
      await transaction`
        DELETE FROM instance_players
        WHERE instance_id = ${instanceId} AND player_id = ${playerId}
      `;
      await transaction`
        UPDATE server_instances
        SET player_count = (
          SELECT count(*)::int FROM instance_players WHERE instance_id = ${instanceId}
        ), updated_at = now()
        WHERE id = ${instanceId}
      `;
      if (effectiveSessionId) {
        await transaction`
          UPDATE session_players
          SET state = 'LEFT', left_at = now()
          WHERE session_id = ${effectiveSessionId} AND player_id = ${playerId}
            AND state <> 'LEFT'
        `;
      }
    });
  }

  private async heartbeat(instanceId: string, playerIds: readonly string[]): Promise<void> {
    await this.sql.begin(async (transaction) => {
      for (const playerId of playerIds) {
        await transaction`
          INSERT INTO instance_players (instance_id, player_id)
          VALUES (${instanceId}, ${playerId})
          ON CONFLICT (instance_id, player_id)
          DO UPDATE SET last_seen_at = now()
        `;
      }
      await transaction`
        DELETE FROM instance_players
        WHERE instance_id = ${instanceId}
          AND last_seen_at < now() - interval '30 seconds'
      `;
      await transaction`
        UPDATE server_instances
        SET player_count = (
          SELECT count(*)::int FROM instance_players WHERE instance_id = ${instanceId}
        ), updated_at = now()
        WHERE id = ${instanceId}
      `;
    });
  }

  private async setSessionState(sessionId: string, state: "STARTING" | "RUNNING"): Promise<void> {
    await this.sql`
      UPDATE game_sessions
      SET state = ${state},
          started_at = CASE WHEN ${state} = 'RUNNING' THEN COALESCE(started_at, now()) ELSE started_at END,
          updated_at = now()
      WHERE id = ${sessionId}
        AND (
          (${state} = 'STARTING' AND state IN ('TRANSFERRING', 'WAITING'))
          OR (${state} = 'RUNNING' AND state = 'STARTING')
        )
    `;
  }

  private async finishSession(sessionId: string, results: unknown): Promise<void> {
    const rows = await this.sql<{ instance_id: string }[]>`
      UPDATE game_sessions
      SET state = 'FINISHED', finished_at = now(), updated_at = now()
      WHERE id = ${sessionId} AND state IN ('STARTING', 'RUNNING')
      RETURNING instance_id
    `;
    await this.recordEvent("session", sessionId, "GAME_RESULTS", results ?? {});
    if (rows[0]?.instance_id) await this.beginDrain(rows[0].instance_id);
  }

  private async recordEvent(
    aggregateType: string,
    aggregateId: string,
    type: string,
    payload: unknown,
  ): Promise<void> {
    await this.sql`
      INSERT INTO events (id, aggregate_type, aggregate_id, type, payload)
      VALUES (
        ${nanoid()}, ${aggregateType}, ${aggregateId}, ${type},
        ${jsonParameter(payload)}::jsonb
      )
    `;
  }
}
