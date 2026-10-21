import { ApplicationError } from "@endercloud/contracts/errors";
import type { TransferIntent } from "@endercloud/contracts/domain";
import { nanoid } from "@endercloud/runtime/id";
import type { Logger } from "@endercloud/runtime/logger";
import { and, asc, eq, gt, inArray, lte, sql } from "drizzle-orm";
import type { Database, Transaction } from "../../db/client.ts";
import * as schema from "../../db/schema.ts";
import type { RedisEventBus } from "../../events/redis-bus.ts";

export type TransferPayload = TransferIntent;

interface TransferCommandRow {
  id: string;
  expiresAt: Date;
  payload: TransferIntent;
}

export class TransferService {
  private running = false;

  public constructor(
    private readonly db: Database,
    private readonly bus: RedisEventBus,
    private readonly logger: Logger,
  ) {}

  // Persist a durable transfer command inside the caller transaction.
  public async enqueue(
    tx: Transaction,
    payload: TransferPayload,
    sessionId?: string,
  ): Promise<string> {
    const commandId = nanoid();
    const target = await tx
      .select({ timeoutMs: schema.serverGroups.transferTimeoutMs })
      .from(schema.serverInstances)
      .innerJoin(schema.serverGroups, eq(schema.serverGroups.id, schema.serverInstances.groupId))
      .where(
        and(
          eq(schema.serverInstances.id, payload.instanceId),
          inArray(schema.serverGroups.type, ["hub", "minigame"]),
        ),
      )
      .limit(1);
    if (!target[0])
      throw new ApplicationError(
        "CONFLICT",
        409,
        `Transfer target ${payload.instanceId} is unavailable`,
      );
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
      expiresAt: sql`now() + (${target[0].timeoutMs} * interval '1 millisecond')`,
    });
    if (payload.players.length > 0) {
      const generations = new Map<string, number>();
      for (const playerId of [...new Set(payload.players)].sort()) {
        const [current] = await tx
          .insert(schema.playerTransferGenerations)
          .values({ playerId, generation: 1 })
          .onConflictDoUpdate({
            target: schema.playerTransferGenerations.playerId,
            set: { generation: sql`${schema.playerTransferGenerations.generation} + 1` },
          })
          .returning();
        if (!current || !Number.isSafeInteger(current.generation))
          throw new Error("Transfer generation exceeded safe bounds");
        generations.set(playerId, current.generation);
        await tx
          .update(schema.transferCommandPlayers)
          .set({ state: "SUPERSEDED", observedAt: sql`now()` })
          .where(
            and(
              eq(schema.transferCommandPlayers.playerId, playerId),
              eq(schema.transferCommandPlayers.state, "PENDING"),
            ),
          );
      }
      await tx.insert(schema.transferCommandPlayers).values(
        [...new Set(payload.players)].sort().map((playerId) => ({
          commandId,
          playerId,
          generation: generations.get(playerId)!,
        })),
      );
    }
    return commandId;
  }

  public async abandon(commandId: string, playerId: string, generation: number): Promise<void> {
    await this.db
      .update(schema.transferCommandPlayers)
      .set({ state: "ABANDONED", observedAt: sql`now()` })
      .where(
        and(
          eq(schema.transferCommandPlayers.commandId, commandId),
          eq(schema.transferCommandPlayers.playerId, playerId),
          eq(schema.transferCommandPlayers.generation, generation),
          eq(schema.transferCommandPlayers.state, "PENDING"),
        ),
      );
  }

  // Cancel every pending transfer targeting a failed or draining instance.
  public async cancelForInstance(instanceId: string): Promise<void> {
    await this.db
      .update(schema.transferCommands)
      .set({ state: "CANCELLED", completedAt: sql`now()` })
      .where(
        and(
          eq(schema.transferCommands.instanceId, instanceId),
          eq(schema.transferCommands.state, "PENDING"),
        ),
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
      const commands = await this.db
        .select({
          id: schema.transferCommands.id,
          payload: schema.transferCommands.payload,
          expiresAt: schema.transferCommands.expiresAt,
        })
        .from(schema.transferCommands)
        .where(
          and(
            eq(schema.transferCommands.state, "PENDING"),
            lte(schema.transferCommands.nextAttemptAt, sql`now()`),
            gt(schema.transferCommands.expiresAt, sql`now()`),
          ),
        )
        // Preserve command order so older player moves are retried first.
        .orderBy(asc(schema.transferCommands.createdAt))
        .limit(100);
      const receipts =
        commands.length === 0
          ? []
          : await this.db
              .select({
                commandId: schema.transferCommandPlayers.commandId,
                playerId: schema.transferCommandPlayers.playerId,
                state: schema.transferCommandPlayers.state,
                generation: schema.transferCommandPlayers.generation,
              })
              .from(schema.transferCommandPlayers)
              .where(
                inArray(
                  schema.transferCommandPlayers.commandId,
                  commands.map((command) => command.id),
                ),
              );
      const byCommand = new Map<string, typeof receipts>();
      for (const receipt of receipts) {
        const current = byCommand.get(receipt.commandId) ?? [];
        current.push(receipt);
        byCommand.set(receipt.commandId, current);
      }
      // Publish sequentially to avoid flooding Redis and to preserve deterministic retry updates.
      for (const command of commands) {
        const commandReceipts = byCommand.get(command.id) ?? [];
        const players = commandReceipts
          .filter((receipt) => receipt.state === "PENDING")
          .map((receipt) => receipt.playerId);
        if (players.length > 0)
          await this.publish(
            command,
            players,
            Object.fromEntries(
              (commandReceipts ?? []).map((receipt) => [receipt.playerId, receipt.generation]),
            ),
          );
      }
    } finally {
      this.running = false;
    }
  }

  // Complete commands once every expected player arrived or definitively left.
  private async completeObservedTransfers(): Promise<void> {
    await this.db
      .update(schema.transferCommandPlayers)
      .set({ state: "ARRIVED", observedAt: sql`now()` })
      .where(
        and(
          eq(schema.transferCommandPlayers.state, "PENDING"),
          sql`EXISTS (
          SELECT 1 FROM transfer_commands command
          JOIN instance_players present ON present.instance_id = command.instance_id
          WHERE command.id = ${schema.transferCommandPlayers.commandId}
            AND command.state = 'PENDING'
            AND present.player_id = ${schema.transferCommandPlayers.playerId}
        )`,
        ),
      );
    await this.db
      .update(schema.transferCommandPlayers)
      .set({ state: "LEFT", observedAt: sql`now()` })
      .where(
        and(
          eq(schema.transferCommandPlayers.state, "PENDING"),
          sql`EXISTS (
          SELECT 1 FROM transfer_commands command
          JOIN session_players member ON member.session_id = command.session_id
          WHERE command.id = ${schema.transferCommandPlayers.commandId}
            AND command.state = 'PENDING'
            AND member.player_id = ${schema.transferCommandPlayers.playerId}
            AND member.state = 'LEFT'
        )`,
        ),
      );
    await this.db
      .update(schema.transferCommands)
      .set({ state: "COMPLETED", completedAt: sql`now()` })
      .where(
        and(
          eq(schema.transferCommands.state, "PENDING"),
          sql`NOT EXISTS (SELECT 1 FROM transfer_command_players receipt
            WHERE receipt.command_id = ${schema.transferCommands.id} AND receipt.state = 'PENDING')`,
        ),
      );
  }

  // Mark commands expired once their delivery window closes.
  private async expireTransfers(): Promise<void> {
    const expired = await this.db
      .update(schema.transferCommands)
      .set({ state: "EXPIRED", completedAt: sql`now()` })
      .where(
        and(
          eq(schema.transferCommands.state, "PENDING"),
          lte(schema.transferCommands.expiresAt, sql`now()`),
        ),
      )
      .returning({
        id: schema.transferCommands.id,
        instance_id: schema.transferCommands.instanceId,
      });
    // Emit one warning per command so operators can identify the affected destination.
    for (const command of expired) {
      this.logger.warn("transfer.command.expired", "Transfer command expired", {
        commandId: command.id,
        instanceId: command.instance_id,
      });
    }
  }

  // Publish one command and schedule bounded retries with exponential backoff.
  private async publish(
    command: TransferCommandRow,
    players: readonly string[],
    playerGenerations: Readonly<Record<string, number>>,
  ): Promise<void> {
    try {
      await this.bus.publishTransfer({
        ...command.payload,
        players,
        commandId: command.id,
        expiresAt: command.expiresAt.toISOString(),
        playerGenerations,
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
            eq(schema.transferCommands.state, "PENDING"),
          ),
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
            eq(schema.transferCommands.state, "PENDING"),
          ),
        );
      this.logger.warn("transfer.publication.failed", "Transfer publication failed", {
        commandId: command.id,
        error,
      });
    }
  }
}
