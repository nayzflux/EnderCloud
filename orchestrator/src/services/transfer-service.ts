import type postgres from "postgres";
import type { AppConfig } from "../config.ts";
import type { SqlClient } from "../db/client.ts";
import { jsonParameter } from "../db/json.ts";
import type { RedisEventBus } from "../events/redis-bus.ts";
import { nanoid } from "../id.ts";
import type { Logger } from "../logger.ts";

export interface TransferPayload {
  readonly instanceId: string;
  readonly endpoint: string;
  readonly players: readonly string[];
  readonly commandId?: string;
}

interface TransferCommandRow {
  id: string;
  payload: {
    instanceId: string;
    endpoint: string;
    players: string[];
  };
}

export class TransferService {
  private running = false;

  public constructor(
    private readonly sql: SqlClient,
    private readonly bus: RedisEventBus,
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

  // Persist a durable transfer command inside the caller transaction.
  public async enqueue(
    transaction: postgres.TransactionSql,
    payload: TransferPayload,
    sessionId?: string,
  ): Promise<string> {
    const commandId = nanoid();
    // Store transfer intent in the caller's transaction. Publishing happens later,
    // so a committed session assignment cannot be lost during a Redis outage.
    await transaction`
      INSERT INTO transfer_commands (
        id, instance_id, session_id, payload, expires_at
      ) VALUES (
        ${commandId}, ${payload.instanceId}, ${sessionId ?? null},
        ${jsonParameter({
          instanceId: payload.instanceId,
          endpoint: payload.endpoint,
          players: payload.players,
        })}::jsonb,
        now() + (${this.config.transferTimeoutMs} * interval '1 millisecond')
      )
    `;
    return commandId;
  }

  // Cancel every pending transfer targeting a failed or draining instance.
  public async cancelForInstance(instanceId: string): Promise<void> {
    await this.sql`
      UPDATE transfer_commands
      SET state = 'CANCELLED', completed_at = now()
      WHERE instance_id = ${instanceId} AND state = 'PENDING'
    `;
  }

  // Complete observed commands, expire stale ones, and publish due retries.
  public async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      // Observe arrivals before expiry so a just-completed transfer wins the race with its deadline.
      await this.completeObservedTransfers();
      await this.expireTransfers();
      // Publish only due commands and bound each tick to keep other control loops responsive.
      const commands = await this.sql<TransferCommandRow[]>`
        SELECT id, payload
        FROM transfer_commands
        WHERE state = 'PENDING'
          AND next_attempt_at <= now()
          AND expires_at > now()
        -- Preserve command order so older player moves are retried first.
        ORDER BY created_at
        LIMIT 100
      `;
      // Publish sequentially to avoid flooding Redis and to preserve deterministic retry updates.
      for (const command of commands) {
        await this.publish(command);
      }
    } finally {
      this.running = false;
    }
  }

  // Complete commands once every expected player arrived or definitively left.
  private async completeObservedTransfers(): Promise<void> {
    await this.sql`
      UPDATE transfer_commands tc
      SET state = 'COMPLETED', completed_at = now()
      WHERE tc.state = 'PENDING'
        -- Complete only when no expected player remains unaccounted for.
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(tc.payload->'players') AS expected(player_id)
          WHERE NOT EXISTS (
            SELECT 1
            FROM instance_players ip
            WHERE ip.instance_id = tc.instance_id
              AND ip.player_id = expected.player_id::uuid
          )
          AND NOT (
            tc.session_id IS NOT NULL
            AND EXISTS (
              SELECT 1
              FROM session_players sp
              WHERE sp.session_id = tc.session_id
                AND sp.player_id = expected.player_id::uuid
                AND sp.state = 'LEFT'
            )
          )
        )
    `;
  }

  // Mark commands expired once their delivery window closes.
  private async expireTransfers(): Promise<void> {
    const expired = await this.sql<{ id: string; instance_id: string }[]>`
      UPDATE transfer_commands
      SET state = 'EXPIRED', completed_at = now()
      WHERE state = 'PENDING' AND expires_at <= now()
      RETURNING id, instance_id
    `;
    // Emit one warning per command so operators can identify the affected destination.
    for (const command of expired) {
      this.logger.warn("Transfer command expired", {
        commandId: command.id,
        instanceId: command.instance_id,
      });
    }
  }

  // Publish one command and schedule bounded retries with exponential backoff.
  private async publish(command: TransferCommandRow): Promise<void> {
    try {
      await this.bus.publishTransfer({
        ...command.payload,
        commandId: command.id,
      });
      await this.sql`
        UPDATE transfer_commands
        SET attempts = attempts + 1,
            -- Redis publish is not an acknowledgement; repeat until arrivals are observed.
            next_attempt_at = now() + interval '2 seconds'
        WHERE id = ${command.id} AND state = 'PENDING'
      `;
    } catch (error) {
      await this.sql`
        UPDATE transfer_commands
        SET attempts = attempts + 1,
            next_attempt_at = now() + (
              -- Exponential backoff is capped at 30 seconds to balance recovery and load.
              LEAST(30, power(2, LEAST(attempts, 5))) * interval '1 second'
            )
        WHERE id = ${command.id} AND state = 'PENDING'
      `;
      this.logger.warn("Transfer publication failed", {
        commandId: command.id,
        error: String(error),
      });
    }
  }
}
