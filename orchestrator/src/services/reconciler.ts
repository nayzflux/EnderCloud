import type { Database } from "../db/client.ts";
import { sql, eq, and, ne } from "drizzle-orm";
import { serverInstances, serverGroups, events } from "../db/schema.ts";
import type { LifecycleState } from "../domain/types.ts";
import type { Executor } from "../executor/executor.ts";
import type { Logger } from "../logger.ts";
import { nanoid } from "../id.ts";
import type { InstanceController } from "./instance-controller.ts";

interface InstanceRow {
  id: string;
  lifecycle_state: LifecycleState;
  startup_expired: boolean;
}

export class Reconciler {
  private running = false;

  public constructor(
    private readonly db: Database,
    private readonly executor: Executor,
    private readonly instances: InstanceController,
    private readonly logger: Logger,
  ) {}

  // Converge persisted lifecycle state with the containers currently managed by Docker.
  public async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      // Read desired and actual state concurrently; neither query depends on the other.
      const [databaseInstances, runtimeInstances] = await Promise.all([
        this.db
          .select({
            id: serverInstances.id,
            lifecycle_state: serverInstances.lifecycleState,
            startup_expired: sql<boolean>`(
              ${serverInstances.lifecycleState} = 'STARTING'
              AND ${serverInstances.startupDeadline} <= now()
            )`.as("startup_expired"),
          })
          .from(serverInstances)
          .innerJoin(serverGroups, eq(serverGroups.id, serverInstances.groupId))
          .where(ne(serverInstances.lifecycleState, "STOPPED")) as unknown as Promise<InstanceRow[]>,
        this.executor.listManagedInstances(),
      ]);
      // Index both snapshots once to avoid repeated linear searches inside reconciliation loops.
      const databaseById = new Map(databaseInstances.map((instance) => [instance.id, instance]));
      const runtimeById = new Map(runtimeInstances.map((instance) => [instance.instanceId, instance]));

      // Reconcile each database-owned instance independently so one failure does not abort the scan.
      for (const database of databaseInstances) {
        try {
          const runtime = runtimeById.get(database.id);
          if (database.lifecycle_state === "CREATING") {
            // resumeCreate is idempotent and also repairs the DB state when Docker
            // creation completed just before an orchestrator crash.
            await this.instances.resumeCreate(database.id);
          } else if (database.lifecycle_state === "STARTING" && database.startup_expired) {
            // A server that never reports readiness is failed so capacity can replace it.
            await this.db
              .update(serverInstances)
              .set({ lifecycleState: "FAILED", updatedAt: sql`now()` })
              .where(
                and(
                  eq(serverInstances.id, database.id),
                  eq(serverInstances.lifecycleState, "STARTING")
                )
              );
          } else if (
            // RUNNING/STARTING in the database requires a live container; disappearance is failure.
            (database.lifecycle_state === "RUNNING" ||
              database.lifecycle_state === "STARTING") &&
            (!runtime || !runtime.running)
          ) {
            await this.db
              .update(serverInstances)
              .set({ lifecycleState: "FAILED", updatedAt: sql`now()` })
              .where(eq(serverInstances.id, database.id));
          } else if (database.lifecycle_state === "DRAINING") {
            // Drain waits for zero players, but the deadline guarantees eventual cleanup.
            if (!runtime || !runtime.running) {
              await this.instances.stopAndDelete(database.id);
            } else {
              const rows = (await this.db
                .select({
                  due: sql<boolean>`(${serverInstances.playerCount} = 0 OR ${serverInstances.drainDeadline} <= now())`.as("due"),
                  player_count: serverInstances.playerCount,
                })
                .from(serverInstances)
                .where(eq(serverInstances.id, database.id))) as { due: boolean; player_count: number }[];
              if (rows[0]?.due) await this.instances.stopAndDelete(database.id);
            }
          } else if (database.lifecycle_state === "STOPPING") {
            await this.instances.stopAndDelete(database.id);
          } else if (database.lifecycle_state === "FAILED") {
            await this.instances.stopAndDelete(database.id);
          }
        } catch (error) {
          this.logger.error("Instance reconciliation failed", {
            instanceId: database.id,
            error: String(error),
          });
        }
      }

      // Scan the opposite direction to detect containers with no persisted owner.
      for (const runtime of runtimeInstances) {
        if (!databaseById.has(runtime.instanceId)) {
          this.logger.warn("Quarantined orphan Docker container", {
            instanceId: runtime.instanceId,
            containerId: runtime.containerId,
          });
          await this.db.insert(events).values({
            id: nanoid(),
            aggregateType: "instance",
            aggregateId: runtime.instanceId,
            type: "ORPHAN_DISCOVERED",
            payload: runtime,
          });
        }
      }
    } catch (error) {
      this.logger.error("Reconciliation failed", { error: String(error) });
    } finally {
      this.running = false;
    }
  }
}
