import type { Database } from "../db/client.ts";
import { serverGroups, serverInstances } from "../db/schema.ts";
import { and, eq, notInArray, asc, sql } from "drizzle-orm";
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
    private readonly db: Database,
    private readonly instances: InstanceController,
    private readonly logger: Logger,
  ) {}

  // Reconcile every group pool with its configured warm and absolute limits.
  public async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const groups = await this.db.select().from(serverGroups);
      // Reconcile groups independently so one broken configuration does not block every pool.
      for (const group of groups) {
        try {
          const current = await this.db
            .select({
              id: serverInstances.id,
              lifecycle_state: serverInstances.lifecycleState,
              availability_state: serverInstances.availabilityState,
            })
            .from(serverInstances)
            .where(
              and(
                eq(serverInstances.groupId, group.id),
                notInArray(serverInstances.lifecycleState, ['STOPPED', 'FAILED'])
              )
            )
            .orderBy(
              sql`${serverInstances.runningAt} ASC NULLS LAST`,
              asc(serverInstances.createdAt)
            );
          const decision = decideCapacity(
            {
              minimumInstances: group.minimumInstances,
              maximumInstances: group.maximumInstances,
              minimumWarmInstances: group.minimumWarmInstances,
              maximumWarmInstances: group.maximumWarmInstances,
            },
            current.map((instance) => ({
              lifecycle: instance.lifecycle_state,
              availability: instance.availability_state,
            })),
            group.enabled,
          );
          // Create exactly the deficit calculated by the pure capacity policy.
          for (let index = 0; index < decision.create; index += 1) {
            await this.instances.createWarm(group.id);
          }
          // Only open, fully running instances can be removed without stealing a reservation.
          const drainCandidates = current.filter(
            (instance) =>
              instance.lifecycle_state === "RUNNING" &&
              instance.availability_state === "OPEN",
          );
          // The earlier SQL ordering makes this slice the deterministic scale-down set.
          for (const candidate of drainCandidates.slice(0, decision.drain)) {
            await this.instances.beginDrain(candidate.id);
          }
        } catch (error) {
          this.logger.error("Capacity group tick failed", {
            groupId: group.id,
            error: String(error),
          });
        }
      }
    } catch (error) {
      this.logger.error("Capacity tick failed", { error: String(error) });
    } finally {
      this.running = false;
    }
  }
}
