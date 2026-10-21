import type { ProxyControl,ProxyHeartbeat,ProxySnapshot } from "@endercloud/contracts/domain";
import { and,eq,inArray,sql } from "drizzle-orm";
import type { Database } from "../../db/client.ts";
import { proxyHeartbeats,serverGroups,serverInstances } from "../../db/schema.ts";
import type { InstanceController } from "../instances/lifecycle.ts";

export class ProxyService {
  public constructor(
    private readonly db: Database,
    private readonly instances: InstanceController,
  ) {}

  public async heartbeat(instanceId: string, heartbeat: ProxyHeartbeat): Promise<ProxyControl> {
    const [instance] = await this.db.select({
      lifecycleState: serverInstances.lifecycleState,
      controlLeaseMs: serverGroups.playerStaleTimeoutMs,
    })
      .from(serverInstances)
      .innerJoin(serverGroups, eq(serverGroups.id, serverInstances.groupId))
      .where(and(eq(serverInstances.id, instanceId), eq(serverGroups.type, "proxy")));
    if (!instance) throw new Error(`Proxy ${instanceId} is unavailable`);
    if (instance.lifecycleState === "STARTING" && heartbeat.ready) {
      await this.instances.markReady(instanceId);
    }

    return this.db.transaction(async (tx) => {
      // Lock the instance so a concurrent drain cannot return obsolete admission permission.
      const [current] = await tx.select({ lifecycleState: serverInstances.lifecycleState })
        .from(serverInstances)
        .where(eq(serverInstances.id, instanceId))
        .for("update");
      if (!current || !["CREATING", "STARTING", "RUNNING", "DRAINING"].includes(current.lifecycleState)) {
        throw new Error(`Proxy ${instanceId} is unavailable`);
      }
      await tx.insert(proxyHeartbeats).values({
        proxyId: instanceId,
        ...heartbeat,
        lastSeenAt: sql`now()`,
      }).onConflictDoUpdate({
        target: proxyHeartbeats.proxyId,
        set: { ...heartbeat, lastSeenAt: sql`now()` },
      });
      await tx.update(serverInstances).set({ playerCount: heartbeat.playerCount, updatedAt: sql`now()` })
        .where(eq(serverInstances.id, instanceId));
      return {
        controlLeaseMs: instance.controlLeaseMs,
        lifecycleState: current.lifecycleState,
        acceptingConnections: current.lifecycleState === "RUNNING" && heartbeat.ready,
      };
    });
  }

  public async list(): Promise<readonly ProxySnapshot[]> {
    const rows = await this.db.select({
      instanceId: serverInstances.id,
      groupId: serverInstances.groupId,
      variantId: serverInstances.variantId,
      endpoint: serverInstances.endpoint,
      lifecycleState: serverInstances.lifecycleState,
      playerCount: serverInstances.playerCount,
      lastSeenAt: proxyHeartbeats.lastSeenAt,
      ready: sql<boolean>`COALESCE(${proxyHeartbeats.ready}, false)`,
      acceptingConnections: sql<boolean>`COALESCE(
        ${serverInstances.lifecycleState} = 'RUNNING'
        AND ${proxyHeartbeats.ready} AND ${proxyHeartbeats.acceptingConnections}
        AND ${proxyHeartbeats.lastSeenAt} > now() - (${serverGroups.playerStaleTimeoutMs} * interval '1 millisecond'),
        false
      )`,
    }).from(serverInstances)
      .innerJoin(serverGroups, eq(serverGroups.id, serverInstances.groupId))
      .leftJoin(proxyHeartbeats, eq(proxyHeartbeats.proxyId, serverInstances.id))
      .where(and(
        eq(serverGroups.type, "proxy"),
        inArray(serverInstances.lifecycleState, ["CREATING", "STARTING", "RUNNING", "DRAINING", "STOPPING"]),
      ))
      .orderBy(serverInstances.createdAt, serverInstances.id);
    return rows.map(({ lastSeenAt, ...row }) => ({
      ...row,
      lastHeartbeatAt: lastSeenAt?.toISOString() ?? null,
    }));
  }
}
