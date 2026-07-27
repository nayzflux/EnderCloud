import type { AppConfig } from "../config.ts";
import type { SqlClient } from "../db/client.ts";
import type postgres from "postgres";
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

  // Create an unassigned warm instance for the requested server group.
  public async createWarm(groupId: string): Promise<string> {
    const variant = await this.variants.select(groupId);
    const instanceId = nanoid();
    // Track deletion separately so failed cleanup is visible and retryable.
    const commandId = nanoid();
    // Persist the desired instance and its command before touching Docker. This
    // makes creation recoverable if the orchestrator crashes between the two steps.
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

  // Resume an interrupted CREATE command from persisted state.
  public async resumeCreate(instanceId: string): Promise<void> {
    // Use the newest CREATE command because older attempts may describe an already-retried operation.
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

  // Execute the recoverable database-to-Docker creation workflow.
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
      await this.sql.begin(async (transaction) => {
        await transaction`
          UPDATE server_instances
          SET lifecycle_state = 'STARTING',
              starting_at = COALESCE(starting_at, now()),
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
    if (rows[0]) {
      // Publish registration only for the transaction that actually performed STARTING -> RUNNING.
      await this.bus.publishRegistry("SERVER_REGISTERED", rows[0]);
      return;
    }
    // A repeated SERVER_READY is valid; distinguish idempotency from an invalid lifecycle.
    const current = await this.sql<{ lifecycle_state: string }[]>`
      SELECT lifecycle_state FROM server_instances WHERE id = ${instanceId}
    `;
    if (current[0]?.lifecycle_state !== "RUNNING") {
      throw new Error(`Instance ${instanceId} is unavailable`);
    }
  }

  // Remove an eligible instance from routing and start its drain deadline.
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
      // Remove routing before waiting for players to leave, preventing new joins during drain.
      await this.bus.publishRegistry("SERVER_UNREGISTERED", { instanceId });
      return true;
    }
    return false;
  }

  // Converge a terminal instance to STOPPED and clean its runtime resources.
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
      // Give Minecraft its configured graceful shutdown window before forcing removal.
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

  // Return all running endpoints that may be registered by a proxy.
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
      -- Stable startup ordering keeps proxy registry snapshots deterministic.
      ORDER BY i.running_at, i.id
    `;
  }

  // Return the current versioned player assignment for a minigame instance.
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
      -- Group players by team and preserve assignment order inside each team.
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

  // Record that the game server consumed the expected assignment revision.
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

  // Atomically reflect a player arrival in both instance and session state.
  private async playerJoined(
    instanceId: string,
    playerId: string,
    sessionId?: string,
  ): Promise<void> {
    await this.sql.begin(async (transaction) => {
      const effectiveSessionId = await this.validateEventSession(
        transaction,
        instanceId,
        sessionId,
      );
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
          UPDATE session_players sp
          SET state = 'CONNECTED',
              connected_at = COALESCE(connected_at, now()),
              left_at = NULL
          FROM game_sessions s
          WHERE sp.session_id = ${effectiveSessionId}
            AND sp.player_id = ${playerId}
            AND s.id = sp.session_id
            AND s.state IN ('TRANSFERRING', 'WAITING')
            AND sp.state IN ('SELECTED', 'TRANSFERRING', 'LEFT')
        `;
      }
    });
  }

  // Atomically remove a player from the instance and mark the session departure.
  private async playerLeft(
    instanceId: string,
    playerId: string,
    sessionId?: string,
  ): Promise<void> {
    await this.sql.begin(async (transaction) => {
      const effectiveSessionId = await this.validateEventSession(
        transaction,
        instanceId,
        sessionId,
      );
      // A grace window tolerates one delayed heartbeat before treating a player as absent.
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

  // Reconcile the authoritative player list reported by the game server.
  private async heartbeat(instanceId: string, playerIds: readonly string[]): Promise<void> {
    await this.sql.begin(async (transaction) => {
      const effectiveSessionId = await this.validateEventSession(transaction, instanceId);
      // Refresh every reported player before removing stale rows, making the heartbeat authoritative.
      for (const playerId of playerIds) {
        await transaction`
          INSERT INTO instance_players (instance_id, player_id)
          VALUES (${instanceId}, ${playerId})
          ON CONFLICT (instance_id, player_id)
          DO UPDATE SET last_seen_at = now()
        `;
        if (effectiveSessionId) {
          await transaction`
            UPDATE session_players sp
            SET state = 'CONNECTED',
                connected_at = COALESCE(connected_at, now()),
                left_at = NULL
            FROM game_sessions s
            WHERE sp.session_id = ${effectiveSessionId}
              AND sp.player_id = ${playerId}
              AND s.id = sp.session_id
              AND s.state IN ('TRANSFERRING', 'WAITING')
              AND sp.state IN ('SELECTED', 'TRANSFERRING', 'LEFT')
          `;
        }
      }
      await transaction`
        DELETE FROM instance_players
        WHERE instance_id = ${instanceId}
          AND last_seen_at < now() - interval '30 seconds'
      `;
      if (effectiveSessionId) {
        // Mirror heartbeat removals into session state so transfer completion can account for departures.
        await transaction`
          UPDATE session_players sp
          SET state = 'LEFT', left_at = now()
          WHERE sp.session_id = ${effectiveSessionId}
            AND sp.state = 'CONNECTED'
            AND NOT EXISTS (
              SELECT 1
              FROM instance_players ip
              WHERE ip.instance_id = ${instanceId}
                AND ip.player_id = sp.player_id
            )
        `;
      }
      await transaction`
        UPDATE server_instances
        SET player_count = (
          SELECT count(*)::int FROM instance_players WHERE instance_id = ${instanceId}
        ), updated_at = now()
        WHERE id = ${instanceId}
      `;
    });
  }

  // Apply only valid, idempotent game-driven session state transitions.
  private async setSessionState(
    instanceId: string,
    sessionId: string,
    state: "STARTING" | "RUNNING",
  ): Promise<void> {
    const rows = await this.sql<{ id: string }[]>`
      UPDATE game_sessions s
      SET state = ${state},
          started_at = CASE WHEN ${state} = 'RUNNING' THEN COALESCE(started_at, now()) ELSE started_at END,
          updated_at = now()
      FROM server_instances i
      WHERE s.id = ${sessionId}
        AND i.id = ${instanceId}
        AND i.session_id = s.id
        AND s.instance_id = i.id
        AND (
          (${state} = 'STARTING' AND state IN ('TRANSFERRING', 'WAITING'))
          OR (${state} = 'RUNNING' AND state = 'STARTING')
        )
      RETURNING s.id
    `;
    // The conditional UPDATE is the concurrency-safe transition path.
    if (rows.length > 0) return;
    const current = await this.sql<{ state: string }[]>`
      SELECT s.state
      FROM game_sessions s
      JOIN server_instances i ON i.id = s.instance_id AND i.session_id = s.id
      WHERE s.id = ${sessionId} AND i.id = ${instanceId}
    `;
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
    const rows = await this.sql<{ instance_id: string }[]>`
      UPDATE game_sessions s
      SET state = 'FINISHED', finished_at = now(), updated_at = now()
      FROM server_instances i
      WHERE s.id = ${sessionId}
        AND i.id = ${instanceId}
        AND i.session_id = s.id
        AND s.instance_id = i.id
        AND s.state IN ('STARTING', 'RUNNING')
      RETURNING s.instance_id
    `;
    if (rows.length === 0) {
      const current = await this.sql<{ state: string }[]>`
        SELECT s.state
        FROM game_sessions s
        JOIN server_instances i ON i.id = s.instance_id AND i.session_id = s.id
        WHERE s.id = ${sessionId} AND i.id = ${instanceId}
      `;
      if (current[0]?.state === "FINISHED") return;
      throw this.invalidSessionEvent(instanceId, sessionId);
    }
    await this.recordEvent("session", sessionId, "GAME_RESULTS", results ?? {});
    if (rows[0]?.instance_id) await this.beginDrain(rows[0].instance_id);
  }

  // Reject stale plugin events that refer to a different instance assignment.
  private async validateEventSession(
    transaction: postgres.TransactionSql,
    instanceId: string,
    providedSessionId?: string,
  ): Promise<string | undefined> {
    const rows = await transaction<{ session_id: string | null }[]>`
      SELECT session_id
      FROM server_instances
      WHERE id = ${instanceId}
      FOR SHARE
    `;
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
    await this.sql`
      INSERT INTO events (id, aggregate_type, aggregate_id, type, payload)
      VALUES (
        ${nanoid()}, ${aggregateType}, ${aggregateId}, ${type},
        ${jsonParameter(payload)}::jsonb
      )
    `;
  }
}
