import { and, asc, eq, isNull, lte, sql } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { registryOutbox, registryState, serverInstances, serverGroups, executionHosts } from "../db/schema.ts";
import { nanoid } from "../id.ts";
import type { RedisEventBus } from "./redis-bus.ts";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type RegistryEvent = "SERVER_REGISTERED" | "SERVER_UPDATED" | "SERVER_UNREGISTERED";

export async function enqueueRegistryEvent(tx: Transaction, type: RegistryEvent, payload: unknown): Promise<void> {
  const [state] = await tx.update(registryState).set({ revision: sql`${registryState.revision} + 1` })
    .where(eq(registryState.id, 1)).returning({ revision: registryState.revision });
  if (!state || !Number.isSafeInteger(state.revision)) throw new Error("Registry revision unavailable");
  const instanceId = (payload as { instanceId?: string }).instanceId;
  const servers = instanceId ? await readRegistryServers(tx, instanceId) : [];
  const current = servers[0];
  // Resolve payload after acquiring the registry revision lock: late publishers cannot publish stale state.
  const actualType = current ? (type === "SERVER_REGISTERED" ? type : "SERVER_UPDATED") : "SERVER_UNREGISTERED";
  await tx.insert(registryOutbox).values({ id: nanoid(), revision: state.revision, type: actualType,
    payload: current ?? { instanceId } });
}

export async function readRegistryServers(db: Database | Transaction, instanceId?: string) {
  return db.select({ instanceId: serverInstances.id, variantId: serverInstances.variantId,
    groupId: serverInstances.groupId, groupType: serverGroups.type, endpoint: sql<string>`${serverInstances.endpoint}`,
    lifecycleState: serverInstances.lifecycleState, availabilityState: serverInstances.availabilityState,
    playerCount: serverInstances.playerCount,
    maximumPlayers: sql<number>`COALESCE(${serverGroups.maximumPlayersPerInstance}, ${serverGroups.maximumPlayers}, 0)`,
  }).from(serverInstances).innerJoin(serverGroups, eq(serverGroups.id, serverInstances.groupId))
    .innerJoin(executionHosts, eq(executionHosts.id, serverInstances.hostId)).where(and(
      instanceId ? eq(serverInstances.id, instanceId) : undefined,
      eq(serverInstances.lifecycleState, "RUNNING"), eq(executionHosts.healthState, "ONLINE"),
      sql`${serverGroups.type} IN ('hub', 'minigame')`, sql`${serverInstances.endpoint} IS NOT NULL`,
      sql`(${serverInstances.paperHealthDeadline} IS NULL OR ${serverInstances.paperHealthDeadline} > now())`,
    )).orderBy(serverInstances.runningAt, serverInstances.id);
}

/** Durable at-least-once publication; a crash after PUBLISH may repeat the same event id. */
export class RegistryOutbox {
  public constructor(private readonly db: Database, private readonly bus: Pick<RedisEventBus, "publishRegistry">) {}

  public async tick(): Promise<void> {
    for (let count = 0; count < 100; count += 1) {
      const published = await this.db.transaction(async tx => {
        const [event] = await tx.select().from(registryOutbox)
          .where(isNull(registryOutbox.publishedAt))
          .orderBy(asc(registryOutbox.revision)).limit(1)
          .for("update", { skipLocked: true });
        if (!event || event.nextAttemptAt > new Date()) return false;
        try {
          await this.bus.publishRegistry(event.type as RegistryEvent, event.payload, event.id, event.revision);
          await tx.update(registryOutbox).set({ publishedAt: sql`now()` }).where(eq(registryOutbox.id, event.id));
          return true;
        } catch (error) {
          await tx.update(registryOutbox).set({
            attempts: sql`${registryOutbox.attempts} + 1`,
            nextAttemptAt: sql`now() + interval '1 second' * LEAST(30, power(2, LEAST(${event.attempts}, 5)))`,
          }).where(eq(registryOutbox.id, event.id));
          return { error };
        }
      });
      if (published === false) return;
      if (typeof published === "object") throw published.error;
    }
  }
}
