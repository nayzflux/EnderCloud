import { and, eq, ne, sql } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { executionHosts, gameSessions, serverInstances, sessionPlayers } from "../db/schema.ts";
import type { AvailabilityState, LifecycleState, SessionState } from "../domain/types.ts";
import type { Logger } from "../logger.ts";
import type { HostService } from "./host-service.ts";
import type { InstanceController } from "./instance-controller.ts";

interface MaintenanceInstance {
  readonly id: string;
  readonly group_id: string;
  readonly lifecycle_state: LifecycleState;
  readonly availability_state: AvailabilityState;
  readonly session_state: SessionState | null;
  readonly connected_players: number;
}

export class HostMaintenanceController {
  private running = false;

  public constructor(
    private readonly db: Database,
    private readonly hosts: HostService,
    private readonly instances: InstanceController,
    private readonly logger: Logger,
  ) {}

  public async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const drainingHosts = await this.db.select({ id: executionHosts.id })
        .from(executionHosts)
        .where(eq(executionHosts.adminState, "DRAINING"));
      for (const host of drainingHosts) {
        try {
          await this.drainHost(host.id);
        } catch (error) {
          this.logger.error("host.maintenance.failed", "Host maintenance reconciliation failed", {
            hostId: host.id,
            error,
          });
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async drainHost(hostId: string): Promise<void> {
    const assigned = (await this.db.select({
      id: serverInstances.id,
      group_id: serverInstances.groupId,
      lifecycle_state: serverInstances.lifecycleState,
      availability_state: serverInstances.availabilityState,
      session_state: gameSessions.state,
      connected_players: sql<number>`count(${sessionPlayers.playerId}) FILTER (
        WHERE ${sessionPlayers.state} = 'CONNECTED'
      )::int`.mapWith(Number),
    }).from(serverInstances)
      .leftJoin(gameSessions, eq(gameSessions.id, serverInstances.sessionId))
      .leftJoin(sessionPlayers, eq(sessionPlayers.sessionId, gameSessions.id))
      .where(and(
        eq(serverInstances.hostId, hostId),
        ne(serverInstances.lifecycleState, "STOPPED"),
      ))
      .groupBy(serverInstances.id, gameSessions.id)) as unknown as MaintenanceInstance[];

    if (assigned.length === 0) {
      await this.hosts.markMaintenance(hostId);
      return;
    }

    for (const instance of assigned) {
      if (instance.lifecycle_state === "CREATING" || instance.lifecycle_state === "STARTING") {
        await this.instances.failInstance(instance.id, "HOST_MAINTENANCE", { hostId });
        continue;
      }
      if (instance.lifecycle_state !== "RUNNING") continue;

      if (instance.availability_state === "RESERVED") {
        const canReassign =
          instance.connected_players === 0 &&
          (instance.session_state === "TRANSFERRING" || instance.session_state === "WAITING");
        if (canReassign) {
          await this.instances.failInstance(instance.id, "HOST_MAINTENANCE", { hostId });
        }
        continue;
      }

      const replacements = await this.db.select({
        id: serverInstances.id,
        lifecycle_state: serverInstances.lifecycleState,
      }).from(serverInstances).where(and(
        eq(serverInstances.replacesInstanceId, instance.id),
        ne(serverInstances.lifecycleState, "STOPPED"),
      )).limit(1);
      const replacement = replacements[0];
      if (replacement?.lifecycle_state === "RUNNING") {
        await this.instances.completeReplacement(replacement.id);
      } else if (!replacement) {
        await this.instances.createWarm(
          instance.group_id,
          instance.id,
          "HOST_MAINTENANCE",
        );
      }
    }
  }
}
