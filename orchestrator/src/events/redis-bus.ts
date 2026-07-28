import Redis from "ioredis";
import type { RedisEnvelope } from "../domain/types.ts";
import type { Logger } from "../logger.ts";
import { nanoid } from "../id.ts";

export const REGISTRY_CHANNEL = "minecraft:proxy:registry";
export const TRANSFER_CHANNEL = "minecraft:proxy:transfers";

export class RedisEventBus {
  private readonly redis: Redis;

  public constructor(url: string, logger: Logger) {
    this.redis = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      retryStrategy: (attempt) => Math.min(250 * 2 ** attempt, 5_000),
    });
    this.redis.on("error", (error) =>
      logger.error("Redis publisher error", { error: String(error) }),
    );
  }

  public async connect(): Promise<void> {
    if (this.redis.status === "wait") await this.redis.connect();
  }

  public async close(): Promise<void> {
    await this.redis.quit();
  }

  // Notify proxies when a backend becomes available or unavailable.
  public async publishRegistry(
    type: "SERVER_REGISTERED" | "SERVER_UNREGISTERED",
    payload: unknown,
  ): Promise<void> {
    await this.publish(REGISTRY_CHANNEL, type, payload);
  }

  // Publish a player transfer command for the proxy layer.
  public async publishTransfer(payload: {
    readonly instanceId: string;
    readonly endpoint: string;
    readonly players: readonly string[];
    readonly sourceInstanceId?: string;
    readonly reason?: "SESSION_CANCELLED";
    readonly commandId?: string;
  }): Promise<void> {
    await this.publish(TRANSFER_CHANNEL, "TRANSFER_PLAYERS", payload);
  }

  // Wrap every Redis message in the versioned event envelope.
  private async publish(
    channel: string,
    type: RedisEnvelope["type"],
    payload: unknown,
  ): Promise<void> {
    const envelope: RedisEnvelope = {
      schemaVersion: 1,
      eventId: nanoid(),
      type,
      occurredAt: new Date().toISOString(),
      payload,
    };
    await this.redis.publish(channel, JSON.stringify(envelope));
  }
}
