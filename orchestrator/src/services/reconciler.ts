import { eq, ne, sql } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { events, executionHosts, serverGroups, serverInstances } from "../db/schema.ts";
import type { LifecycleState } from "../domain/types.ts";
import type { Executor, RuntimeInstance } from "../executor/executor.ts";
import { nanoid } from "../id.ts";
import type { Logger } from "../logger.ts";
import type { HostService } from "./host-service.ts";
import type { InstanceController } from "./instance-controller.ts";

interface InstanceRow {
  id: string;
  host_id: string | null;
  lifecycle_state: LifecycleState;
  startup_expired: boolean;
}

interface HostRow {
  id: string;
  last_heartbeat_at: Date;
  last_control_contact_at: Date | null;
  created_at: Date;
}

export class Reconciler {
  private running = false;

  public constructor(
    private readonly db: Database,
    private readonly executor: Executor,
    private readonly instances: InstanceController,
    private readonly hosts: HostService,
    private readonly logger: Logger,
    private readonly offlineAfterMs: number,
  ) {}

  public async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const [databaseInstances, hostRows] = await Promise.all([
        this.db.select({
          id: serverInstances.id,
          host_id: serverInstances.hostId,
          lifecycle_state: serverInstances.lifecycleState,
          startup_expired: sql<boolean>`(
            ${serverInstances.lifecycleState} = 'STARTING'
            AND ${serverInstances.startupDeadline} <= now()
          )`.as("startup_expired"),
        }).from(serverInstances)
          .innerJoin(serverGroups, eq(serverGroups.id, serverInstances.groupId))
          .where(ne(serverInstances.lifecycleState, "STOPPED")) as unknown as Promise<InstanceRow[]>,
        this.db.select({
          id: executionHosts.id,
          last_heartbeat_at: executionHosts.lastHeartbeatAt,
          last_control_contact_at: executionHosts.lastControlContactAt,
          created_at: executionHosts.createdAt,
        }).from(executionHosts) as unknown as Promise<HostRow[]>,
      ]);
      const byHost = new Map<string, InstanceRow[]>();
      for (const instance of databaseInstances) {
        if (!instance.host_id) {
          this.logger.error("Active instance has no execution host", { instanceId: instance.id });
          continue;
        }
        const current = byHost.get(instance.host_id) ?? [];
        current.push(instance);
        byHost.set(instance.host_id, current);
      }

      const now = Date.now();
      const probeable = hostRows.filter((host) =>
        now - host.last_heartbeat_at.getTime() < this.offlineAfterMs
      );
      const probes = await Promise.allSettled(
        probeable.map(async (host) => ({
          host,
          runtime: await this.executor.listManagedInstances(host.id),
        })),
      );
      const successful = new Map<string, readonly RuntimeInstance[]>();
      for (let index = 0; index < probes.length; index += 1) {
        const result = probes[index]!;
        const host = probeable[index]!;
        if (result.status === "fulfilled") successful.set(host.id, result.value.runtime);
      }

      for (const host of hostRows) {
        const runtimeInstances = successful.get(host.id);
        if (!runtimeInstances) {
          const contact = host.last_control_contact_at ?? host.created_at;
          const heartbeatExpired = now - host.last_heartbeat_at.getTime() >= this.offlineAfterMs;
          const controlExpired = now - contact.getTime() >= this.offlineAfterMs;
          if (!heartbeatExpired && !controlExpired) continue;
          const reason = heartbeatExpired
            ? "Agent heartbeat expired"
            : "Agent control API remained unreachable";
          if (await this.hosts.markOffline(host.id, reason)) {
            this.logger.error("Execution host became offline", { hostId: host.id, reason });
            await this.failHostInstances(host.id, byHost.get(host.id) ?? [], reason);
          }
          continue;
        }

        const converged = await this.reconcileHost(
          host.id,
          byHost.get(host.id) ?? [],
          runtimeInstances,
        );
        if (converged) await this.hosts.markOnline(host.id);
      }
    } catch (error) {
      this.logger.error("Reconciliation failed", { error: String(error) });
    } finally {
      this.running = false;
    }
  }

  private async failHostInstances(
    hostId: string,
    instances: readonly InstanceRow[],
    reason: string,
  ): Promise<void> {
    for (const instance of instances) {
      try {
        await this.instances.failInstance(instance.id, "HOST_OFFLINE", { hostId, reason });
      } catch (error) {
        this.logger.error("Failed to transition offline host instance", {
          hostId,
          instanceId: instance.id,
          error: String(error),
        });
      }
    }
  }

  private async reconcileHost(
    hostId: string,
    databaseInstances: readonly InstanceRow[],
    runtimeInstances: readonly RuntimeInstance[],
  ): Promise<boolean> {
    let converged = true;
    const databaseById = new Map(databaseInstances.map((instance) => [instance.id, instance]));
    const runtimeById = new Map(runtimeInstances.map((instance) => [instance.instanceId, instance]));
    for (const database of databaseInstances) {
      try {
        const runtime = runtimeById.get(database.id);
        if (database.lifecycle_state === "CREATING") {
          await this.instances.resumeCreate(database.id);
        } else if (database.lifecycle_state === "STARTING" && database.startup_expired) {
          await this.instances.failInstance(database.id, "STARTUP_TIMEOUT", { hostId });
        } else if (
          (database.lifecycle_state === "RUNNING" || database.lifecycle_state === "STARTING") &&
          (!runtime || !runtime.running)
        ) {
          await this.instances.failInstance(database.id, "RUNTIME_MISSING", { hostId });
        } else if (database.lifecycle_state === "DRAINING") {
          if (!runtime || !runtime.running) {
            await this.instances.stopAndDelete(database.id);
          } else {
            const rows = await this.db.select({
              due: sql<boolean>`(
                ${serverInstances.playerCount} = 0
                OR ${serverInstances.drainDeadline} <= now()
              )`.as("due"),
            }).from(serverInstances).where(eq(serverInstances.id, database.id));
            if (rows[0]?.due) await this.instances.stopAndDelete(database.id);
          }
        } else if (
          database.lifecycle_state === "STOPPING" ||
          database.lifecycle_state === "FAILED" ||
          database.lifecycle_state === "ORPHANED"
        ) {
          await this.instances.stopAndDelete(database.id);
        }
      } catch (error) {
        converged = false;
        this.logger.error("Instance reconciliation failed", {
          hostId,
          instanceId: database.id,
          error: String(error),
        });
      }
    }

    for (const runtime of runtimeInstances) {
      if (databaseById.has(runtime.instanceId)) continue;
      try {
        const current = await this.db.select({
          host_id: serverInstances.hostId,
          lifecycle_state: serverInstances.lifecycleState,
        }).from(serverInstances).where(eq(serverInstances.id, runtime.instanceId)).limit(1);
        if (current[0]?.host_id === hostId && current[0].lifecycle_state !== "STOPPED") continue;

        const cleanup = await this.executor.deleteOrphanInstance(runtime);
        await this.db.insert(events).values({
          id: nanoid(),
          aggregateType: "instance",
          aggregateId: runtime.instanceId,
          type: "ORPHAN_DISCOVERED",
          payload: { ...runtime, cleanup },
        });
        this.logger.info("Removed orphan runtime instance", {
          hostId,
          instanceId: runtime.instanceId,
          containerId: runtime.containerId,
          ...cleanup,
        });
      } catch (error) {
        converged = false;
        this.logger.error("Orphan runtime cleanup failed", {
          hostId,
          instanceId: runtime.instanceId,
          containerId: runtime.containerId,
          error: String(error),
        });
      }
    }
    return converged;
  }
}
