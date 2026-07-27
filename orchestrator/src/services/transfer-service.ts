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

  public async enqueue(
    transaction: postgres.TransactionSql,
    payload: TransferPayload,
    sessionId?: string,
  ): Promise<string> {
    const commandId = nanoid();
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

  public async cancelForInstance(instanceId: string): Promise<void> {
    await this.sql`
      UPDATE transfer_commands
      SET state = 'CANCELLED', completed_at = now()
      WHERE instance_id = ${instanceId} AND state = 'PENDING'
    `;
  }

  public async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.completeObservedTransfers();
      await this.expireTransfers();
      const commands = await this.sql<TransferCommandRow[]>`
        SELECT id, payload
        FROM transfer_commands
        WHERE state = 'PENDING'
          AND next_attempt_at <= now()
          AND expires_at > now()
        ORDER BY created_at
        LIMIT 100
      `;
      for (const command of commands) {
        await this.publish(command);
      }
    } finally {
      this.running = false;
    }
  }

  private async completeObservedTransfers(): Promise<void> {
    await this.sql`
      UPDATE transfer_commands tc
      SET state = 'COMPLETED', completed_at = now()
      WHERE tc.state = 'PENDING'
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

  private async expireTransfers(): Promise<void> {
    const expired = await this.sql<{ id: string; instance_id: string }[]>`
      UPDATE transfer_commands
      SET state = 'EXPIRED', completed_at = now()
      WHERE state = 'PENDING' AND expires_at <= now()
      RETURNING id, instance_id
    `;
    for (const command of expired) {
      this.logger.warn("Transfer command expired", {
        commandId: command.id,
        instanceId: command.instance_id,
      });
    }
  }

  private async publish(command: TransferCommandRow): Promise<void> {
    try {
      await this.bus.publishTransfer({
        ...command.payload,
        commandId: command.id,
      });
      await this.sql`
        UPDATE transfer_commands
        SET attempts = attempts + 1,
            next_attempt_at = now() + interval '2 seconds'
        WHERE id = ${command.id} AND state = 'PENDING'
      `;
    } catch (error) {
      await this.sql`
        UPDATE transfer_commands
        SET attempts = attempts + 1,
            next_attempt_at = now() + (
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
