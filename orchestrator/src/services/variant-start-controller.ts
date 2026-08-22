import { and, eq, inArray, ne, notInArray, sql } from "drizzle-orm";
import type { AppConfig } from "../config.ts";
import type { Database } from "../db/client.ts";
import {
  commands,
  serverGroups,
  serverGroupVariants,
  serverInstances,
  serverVariants,
  variantStartStates,
} from "../db/schema.ts";
import type { Executor } from "../executor/executor.ts";
import type { Logger } from "../logger.ts";
import { decideStartupFailure } from "../domain/startup-policy.ts";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type VariantStartState = "BACKING_OFF" | "PROBING" | "BLOCKED" | "RESETTING";

export interface VariantStartupStatus {
  readonly groupId: string;
  readonly variantId: string;
  readonly revision: number;
  readonly state: VariantStartState;
  readonly failureCount: number;
  readonly retryLimit: number;
  readonly nextRetryAt: string | null;
  readonly lastFailureAt: string | null;
  readonly lastFailedInstanceId: string | null;
  readonly lastFailureReason: string | null;
}

export type RetryRequestResult =
  | { readonly status: "ACCEPTED"; readonly startup: VariantStartupStatus }
  | { readonly status: "NOT_FOUND" }
  | { readonly status: "CONFLICT"; readonly startup?: VariantStartupStatus };

const retainedLogLines = 200;
const retainedLogBytes = 65_536;

function boundLogTail(value: string): string {
  let bounded = value.split(/\r?\n/).slice(-retainedLogLines).join("\n");
  if (Buffer.byteLength(bounded) <= retainedLogBytes) return bounded;
  bounded = Buffer.from(bounded).subarray(-retainedLogBytes).toString("utf8");
  while (Buffer.byteLength(bounded) > retainedLogBytes) bounded = bounded.slice(1);
  return bounded;
}

export class VariantStartController {
  public constructor(
    private readonly db: Database,
    private readonly executor: Executor,
    private readonly config: Pick<AppConfig, "instanceStartRetryLimit" | "instanceStartRetryBaseDelayMs">,
    private readonly logger: Logger,
  ) {}

  public async reserveAttempt(
    tx: Transaction,
    groupId: string,
    variantId: string,
    revision: number,
    instanceId: string,
  ): Promise<boolean> {
    const rows = await tx.select({
      state: variantStartStates.state,
      nextRetryAt: variantStartStates.nextRetryAt,
    }).from(variantStartStates).where(and(
      eq(variantStartStates.groupId, groupId),
      eq(variantStartStates.variantId, variantId),
      eq(variantStartStates.variantRevision, revision),
    )).for("update");
    const current = rows[0];
    if (!current) return true;
    if (current.state !== "BACKING_OFF" || !current.nextRetryAt || current.nextRetryAt > new Date()) {
      return false;
    }
    await tx.update(variantStartStates).set({
      state: "PROBING",
      probeInstanceId: instanceId,
      nextRetryAt: null,
      updatedAt: sql`now()`,
    }).where(and(
      eq(variantStartStates.groupId, groupId),
      eq(variantStartStates.variantId, variantId),
      eq(variantStartStates.variantRevision, revision),
      eq(variantStartStates.state, "BACKING_OFF"),
    ));
    return true;
  }

  public async recordFailure(instanceId: string, reason: string): Promise<VariantStartupStatus | null> {
    const result = await this.db.transaction(async (tx) => {
      const instances = await tx.select({
        groupId: serverInstances.groupId,
        variantId: serverInstances.variantId,
        revision: serverInstances.variantRevision,
      }).from(serverInstances).where(eq(serverInstances.id, instanceId)).for("update");
      const instance = instances[0];
      if (!instance) return null;

      // Serialize failures for one revision even when several healthy-start
      // commands were already in flight before the first failure was observed.
      await tx.select({ groupId: serverGroups.id })
        .from(serverGroups)
        .where(eq(serverGroups.id, instance.groupId))
        .for("update");

      const states = await tx.select()
        .from(variantStartStates)
        .where(and(
          eq(variantStartStates.groupId, instance.groupId),
          eq(variantStartStates.variantId, instance.variantId),
          eq(variantStartStates.variantRevision, instance.revision),
        ))
        .for("update");
      const current = states[0];
      if (current && !(
        current.state === "PROBING" && current.probeInstanceId === instanceId
      )) {
        return {
          startup: this.toStatus(current),
          counted: false,
          cancelledInstanceIds: [] as string[],
        };
      }

      const failureCount = (current?.failureCount ?? 0) + 1;
      const decision = decideStartupFailure(
        failureCount,
        this.config.instanceStartRetryLimit,
        this.config.instanceStartRetryBaseDelayMs,
      );
      const blocked = decision.state === "BLOCKED";
      const delayMs = decision.delayMs;
      const nextRetryAt = delayMs === null ? null : new Date(Date.now() + delayMs);
      const state = blocked ? "BLOCKED" as const : "BACKING_OFF" as const;

      await tx.insert(variantStartStates).values({
        groupId: instance.groupId,
        variantId: instance.variantId,
        variantRevision: instance.revision,
        state,
        failureCount,
        nextRetryAt,
        probeInstanceId: null,
        lastFailedInstanceId: instanceId,
        lastFailureReason: reason,
        lastFailureAt: sql`now()`,
      }).onConflictDoUpdate({
        target: [
          variantStartStates.groupId,
          variantStartStates.variantId,
          variantStartStates.variantRevision,
        ],
        set: {
          state,
          failureCount,
          nextRetryAt,
          probeInstanceId: null,
          lastFailedInstanceId: instanceId,
          lastFailureReason: reason,
          lastFailureAt: sql`now()`,
          updatedAt: sql`now()`,
        },
      });
      const pendingSiblings = await tx.select({
        commandId: commands.id,
        instanceId: serverInstances.id,
      }).from(commands)
        .innerJoin(serverInstances, eq(serverInstances.id, commands.instanceId))
        .where(and(
          eq(commands.operation, "CREATE"),
          eq(commands.state, "PENDING"),
          eq(serverInstances.groupId, instance.groupId),
          eq(serverInstances.variantId, instance.variantId),
          eq(serverInstances.variantRevision, instance.revision),
          eq(serverInstances.lifecycleState, "CREATING"),
          ne(serverInstances.id, instanceId),
        ))
        .for("update");
      const cancelledInstanceIds = pendingSiblings.map((row) => row.instanceId);
      if (pendingSiblings.length > 0) {
        await tx.update(commands).set({
          state: "CANCELLED",
          completedAt: sql`now()`,
          lastError: null,
        }).where(inArray(commands.id, pendingSiblings.map((row) => row.commandId)));
        await tx.update(serverInstances).set({
          lifecycleState: "STOPPED",
          stoppedAt: sql`now()`,
          updatedAt: sql`now()`,
        }).where(inArray(serverInstances.id, cancelledInstanceIds));
      }
      const startup = {
        groupId: instance.groupId,
        variantId: instance.variantId,
        revision: instance.revision,
        state,
        failureCount,
        retryLimit: this.config.instanceStartRetryLimit,
        nextRetryAt: nextRetryAt?.toISOString() ?? null,
        lastFailureAt: new Date().toISOString(),
        lastFailedInstanceId: instanceId,
        lastFailureReason: reason,
      } satisfies VariantStartupStatus;
      return { startup, counted: true, cancelledInstanceIds };
    });
    if (!result) return null;

    const status = result.startup;
    if (!result.counted) {
      this.logger.debug("variant.start.failure_suppressed", "Concurrent startup failure did not advance the retry policy", {
        groupId: status.groupId,
        variantId: status.variantId,
        revision: status.revision,
        instanceId,
        policyState: status.state,
      });
      return status;
    }
    if (result.cancelledInstanceIds.length > 0) {
      this.logger.debug("variant.start.pending_cancelled", "Queued sibling startups were cancelled after a revision failure", {
        groupId: status.groupId,
        variantId: status.variantId,
        revision: status.revision,
        instanceIds: result.cancelledInstanceIds,
      });
    }

    const fields = {
      groupId: status.groupId,
      variantId: status.variantId,
      revision: status.revision,
      instanceId,
      attempt: status.failureCount,
      reason,
      nextRetryAt: status.nextRetryAt,
    };
    if (status.state === "BLOCKED") {
      this.logger.error("variant.start.blocked", "Variant revision blocked after repeated startup failures", fields);
      await this.retainFinalRuntime(instanceId);
    } else {
      this.logger.warn("variant.start.retry_scheduled", "Variant startup retry scheduled", fields);
    }
    return status;
  }

  public async markReady(instanceId: string): Promise<void> {
    const rows = await this.db.select({
      groupId: serverInstances.groupId,
      variantId: serverInstances.variantId,
      revision: serverInstances.variantRevision,
    }).from(serverInstances).where(eq(serverInstances.id, instanceId)).limit(1);
    const instance = rows[0];
    if (!instance) return;
    const removed = await this.db.delete(variantStartStates).where(and(
      eq(variantStartStates.groupId, instance.groupId),
      eq(variantStartStates.variantId, instance.variantId),
      eq(variantStartStates.variantRevision, instance.revision),
    )).returning({ groupId: variantStartStates.groupId });
    if (removed.length > 0) {
      this.logger.info("variant.start.recovered", "Variant revision recovered", {
        ...instance,
        instanceId,
      });
    }
  }

  public async requestReset(groupId: string, variantId: string, revision: number): Promise<RetryRequestResult> {
    const result = await this.db.transaction(async (tx) => {
      const exists = await tx.select({ id: serverVariants.id })
        .from(serverGroupVariants)
        .innerJoin(serverVariants, eq(serverVariants.id, serverGroupVariants.variantId))
        .where(and(
          eq(serverGroupVariants.groupId, groupId),
          eq(serverVariants.id, variantId),
          eq(serverVariants.revision, revision),
        ))
        .limit(1);
      if (!exists[0]) return { status: "NOT_FOUND" } as const;

      const rows = await tx.select().from(variantStartStates).where(and(
        eq(variantStartStates.groupId, groupId),
        eq(variantStartStates.variantId, variantId),
        eq(variantStartStates.variantRevision, revision),
      )).for("update");
      const row = rows[0];
      if (!row) return { status: "CONFLICT" } as const;
      const current = this.toStatus(row);
      if (current.state === "RESETTING") {
        return { status: "ACCEPTED", startup: current, changed: false } as const;
      }
      if (current.state !== "BLOCKED") {
        return { status: "CONFLICT", startup: current } as const;
      }
      await tx.update(variantStartStates).set({
        state: "RESETTING",
        resetRequestedAt: sql`now()`,
        updatedAt: sql`now()`,
      }).where(and(
        eq(variantStartStates.groupId, groupId),
        eq(variantStartStates.variantId, variantId),
        eq(variantStartStates.variantRevision, revision),
        eq(variantStartStates.state, "BLOCKED"),
      ));
      return {
        status: "ACCEPTED",
        startup: { ...current, state: "RESETTING" as const },
        changed: true,
      } as const;
    });
    if (result.status === "ACCEPTED" && result.changed) {
      this.logger.info("variant.start.reset_requested", "Variant startup retry reset requested", {
        groupId,
        variantId,
        revision,
      });
    }
    return result;
  }

  public async getStatus(groupId: string, variantId: string, revision: number): Promise<VariantStartupStatus | null> {
    const rows = await this.db.select().from(variantStartStates).where(and(
      eq(variantStartStates.groupId, groupId),
      eq(variantStartStates.variantId, variantId),
      eq(variantStartStates.variantRevision, revision),
    )).limit(1);
    const row = rows[0];
    return row ? this.toStatus(row) : null;
  }

  public async reconcile(): Promise<void> {
    await this.db.update(variantStartStates).set({
      state: "RESETTING",
      resetRequestedAt: sql`COALESCE(${variantStartStates.resetRequestedAt}, now())`,
      updatedAt: sql`now()`,
    }).where(sql`EXISTS (
      SELECT 1 FROM server_variants current_variant
      WHERE current_variant.id = ${variantStartStates.variantId}
        AND current_variant.revision <> ${variantStartStates.variantRevision}
    )`);

    const resetting = await this.db.select().from(variantStartStates)
      .where(eq(variantStartStates.state, "RESETTING"));
    for (const state of resetting) {
      try {
        await this.cleanupReset(state);
      } catch (error) {
        this.logger.error("variant.start.reset_failed", "Variant startup retry reset failed", {
          groupId: state.groupId,
          variantId: state.variantId,
          revision: state.variantRevision,
          instanceId: state.lastFailedInstanceId,
          error,
        });
      }
    }
  }

  private async retainFinalRuntime(instanceId: string): Promise<void> {
    const rows = await this.db.select({
      hostId: serverInstances.hostId,
      shutdownTimeoutMs: serverGroups.shutdownTimeoutMs,
    }).from(serverInstances)
      .innerJoin(serverGroups, eq(serverGroups.id, serverInstances.groupId))
      .where(eq(serverInstances.id, instanceId))
      .limit(1);
    const target = rows[0];
    if (!target?.hostId) return;
    await this.db.update(serverInstances).set({ runtimeRetained: true, updatedAt: sql`now()` })
      .where(eq(serverInstances.id, instanceId));
    let failureLogTail: string | null = null;
    try {
      failureLogTail = this.executor.getInstanceLogs
        ? boundLogTail(await this.executor.getInstanceLogs(
          { hostId: target.hostId, instanceId },
          retainedLogLines,
          retainedLogBytes,
        ))
        : null;
    } catch (error) {
      this.logger.warn("instance.failure_logs.unavailable", "Failed instance logs could not be collected", {
        instanceId,
        hostId: target.hostId,
        error,
      });
    }
    if (failureLogTail !== null) {
      await this.db.update(serverInstances).set({ failureLogTail, updatedAt: sql`now()` })
        .where(eq(serverInstances.id, instanceId));
    }
    try {
      await this.executor.stopInstance(
        { hostId: target.hostId, instanceId },
        Math.ceil(target.shutdownTimeoutMs / 1_000),
      );
    } catch (error) {
      this.logger.error("instance.failure_runtime.stop_failed", "Failed instance runtime could not be stopped", {
        instanceId,
        hostId: target.hostId,
        error,
      });
    }
  }

  private async cleanupReset(state: typeof variantStartStates.$inferSelect): Promise<void> {
    const revisionInstances = await this.db.select({ id: serverInstances.id })
      .from(serverInstances)
      .where(and(
        eq(serverInstances.groupId, state.groupId),
        eq(serverInstances.variantId, state.variantId),
        eq(serverInstances.variantRevision, state.variantRevision),
        notInArray(serverInstances.lifecycleState, ["STOPPED"]),
      ));
    const instanceIds = [...new Set([
      ...revisionInstances.map((instance) => instance.id),
      ...[state.probeInstanceId, state.lastFailedInstanceId]
        .filter((id): id is string => id !== null),
    ])];
    if (instanceIds.length > 0) {
      const pending = await this.db.select({
        commandId: commands.id,
        instanceId: commands.instanceId,
      }).from(commands).where(and(
        eq(commands.operation, "CREATE"),
        eq(commands.state, "PENDING"),
        inArray(commands.instanceId, instanceIds),
      ));
      if (pending.length > 0) {
        await this.db.update(commands).set({
          state: "CANCELLED",
          completedAt: sql`now()`,
          lastError: null,
        }).where(inArray(commands.id, pending.map((command) => command.commandId)));
        const pendingInstanceIds = pending
          .map((command) => command.instanceId)
          .filter((id): id is string => id !== null);
        if (pendingInstanceIds.length > 0) {
          await this.db.update(serverInstances).set({
            lifecycleState: "STOPPED",
            stoppedAt: sql`now()`,
            updatedAt: sql`now()`,
          }).where(and(
            inArray(serverInstances.id, pendingInstanceIds),
            eq(serverInstances.lifecycleState, "CREATING"),
          ));
        }
      }
      const running = await this.db.select({ id: commands.id })
        .from(commands)
        .where(and(
          eq(commands.operation, "CREATE"),
          eq(commands.state, "RUNNING"),
          inArray(commands.instanceId, instanceIds),
        ))
        .limit(1);
      if (running[0]) {
        this.logger.debug("variant.start.reset_waiting", "Variant reset is waiting for an in-flight startup command", {
          groupId: state.groupId,
          variantId: state.variantId,
          revision: state.variantRevision,
          commandId: running[0].id,
        });
        return;
      }
    }
    for (const instanceId of instanceIds) {
      const rows = await this.db.select({
        lifecycleState: serverInstances.lifecycleState,
        hostId: serverInstances.hostId,
        shutdownTimeoutMs: serverGroups.shutdownTimeoutMs,
      }).from(serverInstances)
        .innerJoin(serverGroups, eq(serverGroups.id, serverInstances.groupId))
        .where(eq(serverInstances.id, instanceId))
        .limit(1);
      const instance = rows[0];
      if (instance && instance.lifecycleState !== "STOPPED" && instance.hostId) {
        const target = { hostId: instance.hostId, instanceId };
        await this.executor.stopInstance(target, Math.ceil(instance.shutdownTimeoutMs / 1_000));
        await this.executor.deleteInstance(target);
      }
      if (instance) {
        await this.db.update(serverInstances).set({
          lifecycleState: "STOPPED",
          stoppedAt: sql`now()`,
          containerId: null,
          runtimePath: null,
          runtimeRetained: false,
          updatedAt: sql`now()`,
        }).where(eq(serverInstances.id, instanceId));
      }
    }
    await this.db.delete(variantStartStates).where(and(
      eq(variantStartStates.groupId, state.groupId),
      eq(variantStartStates.variantId, state.variantId),
      eq(variantStartStates.variantRevision, state.variantRevision),
      eq(variantStartStates.state, "RESETTING"),
    ));
    this.logger.info("variant.start.reset_completed", "Variant startup retry reset completed", {
      groupId: state.groupId,
      variantId: state.variantId,
      revision: state.variantRevision,
      instanceIds,
    });
  }

  private toStatus(row: typeof variantStartStates.$inferSelect): VariantStartupStatus {
    return {
      groupId: row.groupId,
      variantId: row.variantId,
      revision: row.variantRevision,
      state: row.state,
      failureCount: row.failureCount,
      retryLimit: this.config.instanceStartRetryLimit,
      nextRetryAt: row.nextRetryAt?.toISOString() ?? null,
      lastFailureAt: row.lastFailureAt?.toISOString() ?? null,
      lastFailedInstanceId: row.lastFailedInstanceId,
      lastFailureReason: row.lastFailureReason,
    };
  }
}
