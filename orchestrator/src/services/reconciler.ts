import type { SqlClient } from "../db/client.ts";
import { jsonParameter } from "../db/json.ts";
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
    private readonly sql: SqlClient,
    private readonly executor: Executor,
    private readonly instances: InstanceController,
    private readonly logger: Logger,
  ) {}

  public async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const [databaseInstances, runtimeInstances] = await Promise.all([
        this.sql<InstanceRow[]>`
          SELECT
            i.id,
            i.lifecycle_state,
            (
              i.lifecycle_state = 'STARTING'
              AND i.created_at + (g.startup_timeout_ms * interval '1 millisecond') <= now()
            ) AS startup_expired
          FROM server_instances i
          JOIN server_groups g ON g.id = i.group_id
          WHERE i.lifecycle_state NOT IN ('STOPPED')
        `,
        this.executor.listManagedInstances(),
      ]);
      const databaseById = new Map(databaseInstances.map((instance) => [instance.id, instance]));
      const runtimeById = new Map(runtimeInstances.map((instance) => [instance.instanceId, instance]));

      for (const database of databaseInstances) {
        const runtime = runtimeById.get(database.id);
        if (database.lifecycle_state === "CREATING" && !runtime) {
          await this.instances.resumeCreate(database.id);
        } else if (database.lifecycle_state === "STARTING" && database.startup_expired) {
          await this.sql`
            UPDATE server_instances SET lifecycle_state = 'FAILED', updated_at = now()
            WHERE id = ${database.id} AND lifecycle_state = 'STARTING'
          `;
        } else if (
          (database.lifecycle_state === "RUNNING" ||
            database.lifecycle_state === "STARTING") &&
          (!runtime || !runtime.running)
        ) {
          await this.sql`
            UPDATE server_instances SET lifecycle_state = 'FAILED', updated_at = now()
            WHERE id = ${database.id}
          `;
        } else if (database.lifecycle_state === "DRAINING" && runtime?.running) {
          const rows = await this.sql<{ due: boolean; player_count: number }[]>`
            SELECT (player_count = 0 OR drain_deadline <= now()) AS due, player_count
            FROM server_instances WHERE id = ${database.id}
          `;
          if (rows[0]?.due) await this.instances.stopAndDelete(database.id);
        } else if (database.lifecycle_state === "STOPPING") {
          await this.instances.stopAndDelete(database.id);
        } else if (database.lifecycle_state === "FAILED") {
          await this.instances.stopAndDelete(database.id);
        }
      }

      for (const runtime of runtimeInstances) {
        if (!databaseById.has(runtime.instanceId)) {
          this.logger.warn("Quarantined orphan Docker container", {
            instanceId: runtime.instanceId,
            containerId: runtime.containerId,
          });
          await this.sql`
            INSERT INTO events (id, aggregate_type, aggregate_id, type, payload)
            VALUES (
              ${nanoid()}, 'instance', ${runtime.instanceId}, 'ORPHAN_DISCOVERED',
              ${jsonParameter(runtime)}::jsonb
            )
          `;
        }
      }
    } catch (error) {
      this.logger.error("Reconciliation failed", { error: String(error) });
    } finally {
      this.running = false;
    }
  }
}
