import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { commands, serverInstances } from "../db/schema.ts";
import type { Executor } from "@endercloud/contracts/executor";
import type { Logger } from "@endercloud/runtime/logger";
import type { InstanceController } from "./instance-controller.ts";

interface ClaimedCreate {
  readonly commandId: string;
  readonly instanceId: string;
  readonly attempt: number;
}

export class InstanceStartWorker {
  private readonly active = new Map<string, Promise<void>>();
  private accepting = true;
  private claiming = false;
  private stopping = false;
  private readonly recoveries = new Map<string, string>();

  public constructor(
    private readonly db: Database,
    private readonly instances: InstanceController,
    private readonly executor: Executor,
    private readonly logger: Logger,
    private readonly concurrency: number,
  ) {}

  public async recoverInterrupted(): Promise<number> {
    const recovered = await this.db.update(commands).set({
      state: "PENDING",
      startedAt: null,
      lastError: null,
    }).where(and(
      eq(commands.operation, "CREATE"),
      eq(commands.state, "RUNNING"),
    )).returning({ id: commands.id });
    if (recovered.length > 0) {
      this.logger.info("instance.worker.recovered", "Interrupted instance startups returned to the queue", {
        commandCount: recovered.length,
      });
    }
    return recovered.length;
  }

  public async tick(): Promise<void> {
    if (!this.accepting || this.claiming) {
      return;
    }
    this.claiming = true;
    try {
      // A failed persistence attempt remains here until PostgreSQL accepts it.
      // Never turn a local command failure into an unhandled process rejection.
      for (const [commandId, message] of this.recoveries) {
        await this.db.update(commands).set({
          state: "PENDING",
          startedAt: null,
          lastError: message,
          nextAttemptAt: sql`now() + interval '1 second'`,
        }).where(and(eq(commands.id, commandId), eq(commands.state, "RUNNING")));
        this.recoveries.delete(commandId);
      }
      if (!this.accepting) return;
      const available = this.concurrency - this.active.size;
      if (available <= 0) {
        return;
      }
      const claimed = await this.claim(available);
      if (claimed.length > 0) {
        this.logger.debug("instance.worker.claimed", "Instance startup commands claimed", {
          commandCount: claimed.length,
          activeCount: this.active.size,
          concurrency: this.concurrency,
        });
      }
      for (const command of claimed) {
        this.launch(command);
      }
    } finally {
      this.claiming = false;
    }
  }

  public async stop(graceMs = 10_000): Promise<void> {
    this.accepting = false;
    this.stopping = true;
    this.executor.cancelPending?.();
    if (this.active.size > 0) {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;
      await Promise.race([
        Promise.allSettled([...this.active.values()]),
        new Promise<void>((resolve) => {
          timeout = setTimeout(() => {
            timedOut = true;
            resolve();
          }, graceMs);
        }),
      ]);
      if (timeout) clearTimeout(timeout);
      if (timedOut) {
        this.logger.warn("instance.worker.shutdown_timeout", "Instance startup worker exceeded its shutdown grace period", {
          activeCount: this.active.size,
          graceMs,
        });
      }
    }
    await this.recoverInterrupted();
  }

  private async claim(limit: number): Promise<ClaimedCreate[]> {
    return this.db.transaction(async (tx) => {
      const rows = await tx.select({
        commandId: commands.id,
        instanceId: serverInstances.id,
        attempts: commands.attempts,
      }).from(commands)
        .innerJoin(serverInstances, eq(serverInstances.id, commands.instanceId))
        .where(and(
          eq(commands.operation, "CREATE"),
          eq(commands.state, "PENDING"),
          lte(commands.nextAttemptAt, sql`now()`),
          inArray(serverInstances.lifecycleState, ["CREATING", "STARTING"]),
          sql`NOT EXISTS (
            SELECT 1 FROM variant_start_states startup_policy
            WHERE startup_policy.group_id = ${serverInstances.groupId}
              AND startup_policy.variant_id = ${serverInstances.variantId}
              AND startup_policy.variant_revision = ${serverInstances.variantRevision}
              AND NOT (
                startup_policy.state = 'PROBING'
                AND startup_policy.probe_instance_id = ${serverInstances.id}
              )
          )`,
        ))
        .orderBy(asc(commands.createdAt), asc(commands.id))
        .limit(limit)
        .for("update", { skipLocked: true });
      if (rows.length === 0) return [];
      const ids = rows.map((row) => row.commandId);
      await tx.update(commands).set({
        state: "RUNNING",
        attempts: sql`${commands.attempts} + 1`,
        startedAt: sql`now()`,
        completedAt: null,
        lastError: null,
      }).where(inArray(commands.id, ids));
      return rows.map((row) => ({
        commandId: row.commandId,
        instanceId: row.instanceId,
        attempt: row.attempts + 1,
      }));
    });
  }

  private launch(command: ClaimedCreate): void {
    const operation = Promise.resolve().then(() => this.logger.runWithContext({
      commandId: command.commandId,
      instanceId: command.instanceId,
      attempt: command.attempt,
    }, async () => {
      const startedAt = performance.now();
      this.logger.debug("instance.worker.started", "Instance startup command started");
      try {
        await this.instances.executeCreate(
          command.instanceId,
          command.commandId,
          () => this.stopping,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.recoveries.set(command.commandId, message);
        this.logger.error("instance.worker.command_failed", "Startup command will be recovered", {
          error,
          commandId: command.commandId,
          instanceId: command.instanceId,
        });
      } finally {
        this.logger.debug("instance.worker.completed", "Instance startup command completed", {
          durationMs: Math.round(performance.now() - startedAt),
        });
        this.active.delete(command.commandId);
        if (this.accepting) {
          void this.tick().catch((error) => {
            this.logger.error("instance.worker.tick_failed", "Instance startup worker tick failed", { error });
          });
        }
      }
    }));
    this.active.set(command.commandId, operation);
  }
}
