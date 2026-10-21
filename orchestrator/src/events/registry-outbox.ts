import { and, asc, eq, isNull, lte, sql } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { registryOutbox } from "../db/schema.ts";
import { nanoid } from "../id.ts";
import type { RedisEventBus } from "./redis-bus.ts";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type RegistryEvent = "SERVER_REGISTERED" | "SERVER_UPDATED" | "SERVER_UNREGISTERED";

export async function enqueueRegistryEvent(tx: Transaction, type: RegistryEvent, payload: unknown): Promise<void> {
  await tx.insert(registryOutbox).values({ id: nanoid(), type, payload });
}

/** Durable at-least-once publication; a crash after PUBLISH may repeat the same event id. */
export class RegistryOutbox {
  public constructor(private readonly db: Database, private readonly bus: Pick<RedisEventBus, "publishRegistry">) {}

  public async tick(): Promise<void> {
    for (let count = 0; count < 100; count += 1) {
      const published = await this.db.transaction(async tx => {
        const [event] = await tx.select().from(registryOutbox)
          .where(and(isNull(registryOutbox.publishedAt), lte(registryOutbox.nextAttemptAt, sql`now()`)))
          .orderBy(asc(registryOutbox.createdAt), asc(registryOutbox.id)).limit(1)
          .for("update", { skipLocked: true });
        if (!event) return false;
        try {
          await this.bus.publishRegistry(event.type as RegistryEvent, event.payload, event.id);
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
