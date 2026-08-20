import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { events, executionHosts, serverInstances } from "../db/schema.ts";
import { selectExecutionHost } from "../domain/host-placement.ts";
import type { VariantRuntimeSpec } from "../domain/types.ts";
import { nanoid } from "../id.ts";

export interface HostHeartbeat {
  readonly controlUrl: string;
  readonly gameAddress: string;
  readonly allocatableCpu: number;
  readonly allocatableMemoryBytes: number;
  readonly agentVersion: string;
}

export interface ExecutionHostTarget {
  readonly id: string;
  readonly controlUrl: string;
  readonly gameAddress: string;
}

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export class HostService {
  public constructor(private readonly db: Database) {}

  public async heartbeat(hostId: string, heartbeat: HostHeartbeat): Promise<void> {
    await this.db.insert(executionHosts).values({
      id: hostId,
      controlUrl: heartbeat.controlUrl,
      gameAddress: heartbeat.gameAddress,
      allocatableCpu: heartbeat.allocatableCpu,
      allocatableMemoryBytes: heartbeat.allocatableMemoryBytes,
      agentVersion: heartbeat.agentVersion,
      lastHeartbeatAt: sql`now()`,
    }).onConflictDoUpdate({
      target: executionHosts.id,
      set: {
        controlUrl: heartbeat.controlUrl,
        gameAddress: heartbeat.gameAddress,
        allocatableCpu: heartbeat.allocatableCpu,
        allocatableMemoryBytes: heartbeat.allocatableMemoryBytes,
        agentVersion: heartbeat.agentVersion,
        lastHeartbeatAt: sql`now()`,
        healthState: sql`CASE
          WHEN ${executionHosts.healthState} = 'OFFLINE' THEN 'RECOVERING'::execution_host_health
          ELSE ${executionHosts.healthState}
        END`,
        updatedAt: sql`now()`,
      },
    });
  }

  public async getTarget(hostId: string): Promise<ExecutionHostTarget> {
    const rows = await this.db.select({
      id: executionHosts.id,
      controlUrl: executionHosts.controlUrl,
      gameAddress: executionHosts.gameAddress,
    }).from(executionHosts).where(eq(executionHosts.id, hostId)).limit(1);
    const host = rows[0];
    if (!host) throw new Error(`Execution host ${hostId} is unavailable`);
    return host;
  }

  public async recordControlSuccess(hostId: string): Promise<void> {
    await this.db.update(executionHosts).set({
      lastControlContactAt: sql`now()`,
      lastError: null,
      updatedAt: sql`now()`,
    }).where(eq(executionHosts.id, hostId));
  }

  public async markOnline(hostId: string): Promise<void> {
    await this.db.update(executionHosts).set({
      healthState: "ONLINE",
      lastControlContactAt: sql`now()`,
      lastError: null,
      updatedAt: sql`now()`,
    }).where(eq(executionHosts.id, hostId));
  }

  public async markOffline(hostId: string, error: string): Promise<boolean> {
    const changed = await this.db.update(executionHosts).set({
      healthState: "OFFLINE",
      lastError: error.slice(0, 2_000),
      updatedAt: sql`now()`,
    }).where(and(
      eq(executionHosts.id, hostId),
      ne(executionHosts.healthState, "OFFLINE"),
    )).returning({ id: executionHosts.id });
    return changed.length > 0;
  }

  public async recordControlFailure(hostId: string, error: string): Promise<void> {
    await this.db.update(executionHosts).set({
      healthState: sql`CASE
        WHEN ${executionHosts.healthState} = 'OFFLINE' THEN 'OFFLINE'::execution_host_health
        ELSE 'RECOVERING'::execution_host_health
      END`,
      lastError: error.slice(0, 2_000),
      updatedAt: sql`now()`,
    }).where(eq(executionHosts.id, hostId));
  }

  public async requestDrain(hostId: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const changed = await tx.update(executionHosts).set({
        adminState: "DRAINING",
        updatedAt: sql`now()`,
      }).where(and(
        eq(executionHosts.id, hostId),
        eq(executionHosts.adminState, "ACTIVE"),
      )).returning({ id: executionHosts.id });
      if (changed.length === 0) return false;
      await tx.insert(events).values({
        id: nanoid(),
        aggregateType: "host",
        aggregateId: hostId,
        type: "HOST_DRAIN_REQUESTED",
        payload: {},
      });
      return true;
    });
  }

  public async activate(hostId: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const changed = await tx.update(executionHosts).set({
        adminState: "ACTIVE",
        healthState: "RECOVERING",
        updatedAt: sql`now()`,
      }).where(and(
        eq(executionHosts.id, hostId),
        eq(executionHosts.adminState, "MAINTENANCE"),
      )).returning({ id: executionHosts.id });
      if (changed.length === 0) return false;
      await tx.insert(events).values({
        id: nanoid(),
        aggregateType: "host",
        aggregateId: hostId,
        type: "HOST_ACTIVATED",
        payload: {},
      });
      return true;
    });
  }

  public async markMaintenance(hostId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const changed = await tx.update(executionHosts).set({
        adminState: "MAINTENANCE",
        updatedAt: sql`now()`,
      }).where(and(
        eq(executionHosts.id, hostId),
        eq(executionHosts.adminState, "DRAINING"),
      )).returning({ id: executionHosts.id });
      if (changed.length === 0) return;
      await tx.insert(events).values({
        id: nanoid(),
        aggregateType: "host",
        aggregateId: hostId,
        type: "HOST_MAINTENANCE_STARTED",
        payload: {},
      });
    });
  }

  public async selectForPlacement(
    tx: Transaction,
    runtime: VariantRuntimeSpec,
    excludedHostId?: string,
  ): Promise<string | null> {
    const filters = [
      eq(executionHosts.healthState, "ONLINE"),
      eq(executionHosts.adminState, "ACTIVE"),
    ];
    if (excludedHostId) filters.push(ne(executionHosts.id, excludedHostId));
    const hosts = await tx.select({
      id: executionHosts.id,
      allocatableCpu: executionHosts.allocatableCpu,
      allocatableMemoryBytes: executionHosts.allocatableMemoryBytes,
    }).from(executionHosts).where(and(...filters)).orderBy(executionHosts.id).for("update");
    if (hosts.length === 0) return null;

    const reservations = await tx.select({
      hostId: serverInstances.hostId,
      cpu: sql<number>`COALESCE(sum(${serverInstances.reservedCpu}), 0)::float8`.mapWith(Number),
      memory: sql<number>`COALESCE(sum(${serverInstances.reservedMemoryBytes}), 0)::float8`.mapWith(Number),
    }).from(serverInstances).where(and(
      inArray(serverInstances.hostId, hosts.map((host) => host.id)),
      ne(serverInstances.lifecycleState, "STOPPED"),
    )).groupBy(serverInstances.hostId);
    const byHost = new Map(reservations.map((row) => [row.hostId, row]));
    return selectExecutionHost(
      hosts.map((host) => ({
        ...host,
        reservedCpu: byHost.get(host.id)?.cpu ?? 0,
        reservedMemoryBytes: byHost.get(host.id)?.memory ?? 0,
      })),
      { cpu: runtime.cpu, memoryBytes: runtime.memoryBytes },
    )?.id ?? null;
  }
}
