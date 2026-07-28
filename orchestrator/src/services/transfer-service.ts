import type postgres from "postgres";
import type { AppConfig } from "../config.ts";
import type { Database } from "../db/client.ts";
import { sql, eq, and, lte, gt, asc } from "drizzle-orm";
import type { RedisEventBus } from "../events/redis-bus.ts";
import { nanoid } from "../id.ts";
import type { Logger } from "../logger.ts";
import * as schema from "../db/schema.ts";

export interface TransferPayload {
  readonly instanceId: string;
  readonly endpoint: string;
  readonly players: readonly string[];
  readonly sourceInstanceId?: string;
  readonly reason?: "SESSION_CANCELLED";
  readonly commandId?: string;
}

interface TransferCommandRow {
  id: string;
  payload: {
    instanceId: string;
    endpoint: string;
    players: string[];
    sourceInstanceId?: string;
    reason?: "SESSION_CANCELLED";
  };
}

export class TransferService {
  private running = false;

  public constructor(
    private readonly db: Database,
    private readonly bus: RedisEventBus,
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

  // Persist a durable transfer command inside the caller transaction.
  public async enqueue(
    tx: any,
    payload: TransferPayload,
    sessionId?: string,
  ): Promise<string> {
    const commandId = nanoid();
    // Store transfer intent in the caller's transaction. Publishing happens later,
    // so a committed session assignment cannot be lost during a Redis outage.
    await tx.insert(schema.transferCommands).values({
      id: commandId,
      instanceId: payload.instanceId,
      sessionId: sessionId ?? null,
      payload: {
        instanceId: payload.instanceId,
        endpoint: payload.endpoint,
        players: payload.players,
        ...(payload.sourceInstanceId ? { sourceInstanceId: payload.sourceInstanceId } : {}),
        ...(payload.reason ? { reason: payload.reason } : {}),
      },
      expiresAt: sql`now() + (${this.config.transferTimeoutMs} * interval '1 millisecond')`
    });
    return commandId;
  }

  // Cancel every pending transfer targeting a failed or draining instance.
  public async cancelForInstance(instanceId: string): Promise<void> {
    await this.db
      .update(schema.transferCommands)
      .set({ state: "CANCELLED", completedAt: sql`now()` })
      .where(
        and(
          eq(schema.transferCommands.instanceId, instanceId),
          eq(schema.transferCommands.state, "PENDING")
        )
      );
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
      const commands = (await this.db
        .select({
          id: schema.transferCommands.id,
          payload: schema.transferCommands.payload,
        })
        .from(schema.transferCommands)
        .where(
          and(
            eq(schema.transferCommands.state, "PENDING"),
            lte(schema.transferCommands.nextAttemptAt, sql`now()`),
            gt(schema.transferCommands.expiresAt, sql`now()`)
          )
        )
        // Preserve command order so older player moves are retried first.
        .orderBy(asc(schema.transferCommands.createdAt))
        .limit(100)) as unknown as TransferCommandRow[];
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
    await this.db
      .update(schema.transferCommands)
      .set({ state: "COMPLETED", completedAt: sql`now()` })
      .where(
        and(
          eq(schema.transferCommands.state, "PENDING"),
          // Complete only when no expected player remains unaccounted for.
          sql`NOT EXISTS (
            SELECT 1
            FROM jsonb_array_elements_text(${schema.transferCommands.payload}->'players') AS expected(player_id)
            WHERE NOT EXISTS (
              SELECT 1
              FROM instance_players ip
              WHERE ip.instance_id = ${schema.transferCommands.instanceId}
                AND ip.player_id = expected.player_id::uuid
            )
            AND NOT (
              ${schema.transferCommands.sessionId} IS NOT NULL
              AND EXISTS (
                SELECT 1
                FROM session_players sp
                WHERE sp.session_id = ${schema.transferCommands.sessionId}
                  AND sp.player_id = expected.player_id::uuid
                  AND sp.state = 'LEFT'
              )
            )
          )`
        )
      );
  }

  // Mark commands expired once their delivery window closes.
  private async expireTransfers(): Promise<void> {
    const expired = (await this.db
      .update(schema.transferCommands)
      .set({ state: "EXPIRED", completedAt: sql`now()` })
      .where(
        and(
          eq(schema.transferCommands.state, "PENDING"),
          lte(schema.transferCommands.expiresAt, sql`now()`)
        )
      )
      .returning({
        id: schema.transferCommands.id,
        instance_id: schema.transferCommands.instanceId,
      })) as unknown as { id: string; instance_id: string }[];
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
      await this.db
        .update(schema.transferCommands)
        .set({
          attempts: sql`${schema.transferCommands.attempts} + 1`,
          // Redis publish is not an acknowledgement; repeat until arrivals are observed.
          nextAttemptAt: sql`now() + interval '2 seconds'`,
        })
        .where(
          and(
            eq(schema.transferCommands.id, command.id),
            eq(schema.transferCommands.state, "PENDING")
          )
        );
    } catch (error) {
      await this.db
        .update(schema.transferCommands)
        .set({
          attempts: sql`${schema.transferCommands.attempts} + 1`,
          nextAttemptAt: sql`now() + (
            -- Exponential backoff is capped at 30 seconds to balance recovery and load.
            LEAST(30, power(2, LEAST(${schema.transferCommands.attempts}, 5))) * interval '1 second'
          )`,
        })
        .where(
          and(
            eq(schema.transferCommands.id, command.id),
            eq(schema.transferCommands.state, "PENDING")
          )
        );
      this.logger.warn("Transfer publication failed", {
        commandId: command.id,
        error: String(error),
      });
    }
  }
}
