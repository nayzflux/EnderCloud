import type { RedisEnvelope } from "@endercloud/contracts/domain";
import { nanoid } from "@endercloud/runtime/id";
import type { Logger } from "@endercloud/runtime/logger";
import Redis from "ioredis";

export const REGISTRY_CHANNEL = "minecraft:proxy:registry";
export const TRANSFER_CHANNEL = "minecraft:proxy:transfers";

export class RedisEventBus {
  private readonly redis: Redis;

  public constructor(url: string, logger: Logger) {
    this.redis = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 3_000,
      commandTimeout: 5_000,
      retryStrategy: (attempt) => Math.min(250 * 2 ** attempt, 5_000),
    });
    this.redis.on("error", (error) =>
      logger.error("redis.publisher.failed", "Redis publisher failed", { error }),
    );
  }

  public async connect(): Promise<void> {
    if (this.redis.status === "wait") await this.redis.connect();
  }

  public async close(): Promise<void> {
    try {
      if (this.redis.status === "ready") await this.redis.quit();
    } finally { this.redis.disconnect(); }
  }

  // Notify proxies when a backend becomes available or unavailable.
  public async publishRegistry(
    type: "SERVER_REGISTERED" | "SERVER_UPDATED" | "SERVER_UNREGISTERED",
    payload: unknown,
    eventId?: string,
    registryRevision?: number,
  ): Promise<void> {
    await this.publish(REGISTRY_CHANNEL, type, payload, eventId, registryRevision);
  }

  // Publish a player transfer command for the proxy layer.
  public async publishTransfer(payload: {
    readonly instanceId: string;
    readonly endpoint: string;
    readonly players: readonly string[];
    readonly sourceInstanceId?: string;
    readonly reason?: "SESSION_CANCELLED";
    readonly commandId: string;
    readonly expiresAt: string;
    readonly playerGenerations: Readonly<Record<string, number>>;
  }): Promise<void> {
    await this.publish(TRANSFER_CHANNEL, "TRANSFER_PLAYERS", payload);
  }

  // Wrap every Redis message in the versioned event envelope.
  private async publish(
    channel: string,
    type: RedisEnvelope["type"],
    payload: unknown,
    eventId = nanoid(),
    registryRevision?: number,
  ): Promise<void> {
    const envelope: RedisEnvelope = {
      schemaVersion: 2,
      eventId,
      ...(registryRevision !== undefined ? { registryRevision } : {}),
      type,
      occurredAt: new Date().toISOString(),
      payload,
    };
    await this.redis.publish(channel, JSON.stringify(envelope));
  }
}
