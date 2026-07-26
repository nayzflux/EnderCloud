import type { SqlClient } from "../db/client.ts";
import { decideCapacity } from "../domain/capacity.ts";
import type { AvailabilityState, LifecycleState } from "../domain/types.ts";
import type { Logger } from "../logger.ts";
import type { InstanceController } from "./instance-controller.ts";

interface GroupRow {
  id: string;
  enabled: boolean;
  minimum_instances: number;
  maximum_instances: number;
  minimum_warm_instances: number;
  maximum_warm_instances: number;
}

interface InstanceRow {
  id: string;
  lifecycle_state: LifecycleState;
  availability_state: AvailabilityState;
}

export class CapacityController {
  private running = false;

  public constructor(
    private readonly sql: SqlClient,
    private readonly instances: InstanceController,
    private readonly logger: Logger,
  ) {}

  public async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const groups = await this.sql<GroupRow[]>`
        SELECT id, enabled, minimum_instances, maximum_instances,
               minimum_warm_instances, maximum_warm_instances
        FROM server_groups
      `;
      for (const group of groups) {
        const current = await this.sql<InstanceRow[]>`
          SELECT id, lifecycle_state, availability_state
          FROM server_instances
          WHERE group_id = ${group.id}
            AND lifecycle_state NOT IN ('STOPPED', 'FAILED')
          ORDER BY running_at NULLS LAST, created_at
        `;
        const decision = decideCapacity(
          {
            minimumInstances: group.minimum_instances,
            maximumInstances: group.maximum_instances,
            minimumWarmInstances: group.minimum_warm_instances,
            maximumWarmInstances: group.maximum_warm_instances,
          },
          current.map((instance) => ({
            lifecycle: instance.lifecycle_state,
            availability: instance.availability_state,
          })),
          group.enabled,
        );
        for (let index = 0; index < decision.create; index += 1) {
          await this.instances.createWarm(group.id);
        }
        const drainCandidates = current.filter(
          (instance) =>
            instance.lifecycle_state === "RUNNING" &&
            instance.availability_state === "OPEN",
        );
        for (const candidate of drainCandidates.slice(0, decision.drain)) {
          await this.instances.beginDrain(candidate.id);
        }
      }
    } catch (error) {
      this.logger.error("Capacity tick failed", { error: String(error) });
    } finally {
      this.running = false;
    }
  }
}
