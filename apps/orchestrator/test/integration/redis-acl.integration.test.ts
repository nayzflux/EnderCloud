import { expect, test } from "bun:test";
import { GenericContainer } from "testcontainers";
import Redis from "ioredis";
import { resolve } from "node:path";

test("deployment Redis ACL restricts publishers and subscribers to control channels", async () => {
  const publisherPassword = "test-publisher-" + "a".repeat(32);
  const proxyPassword = "test-subscriber-" + "b".repeat(32);
  const script = await Bun.file(
    resolve(import.meta.dirname, "../../../..", "deployment-tools/start-redis.sh"),
  ).text();
  const container = await new GenericContainer("redis:8.4.0-alpine")
    .withEnvironment({
      REDIS_PUBLISHER_PASSWORD: publisherPassword,
      REDIS_PROXY_PASSWORD: proxyPassword,
    })
    .withCopyContentToContainer([
      { content: script.replaceAll("\r\n", "\n"), target: "/tmp/start-redis.sh" },
    ])
    .withCommand(["sh", "/tmp/start-redis.sh"])
    .withExposedPorts(6379)
    .start();
  const clients: Redis[] = [];
  function client(username?: string, password?: string) {
    const connection = new Redis({
      host: container.getHost(),
      port: container.getMappedPort(6379),
      username,
      password,
      lazyConnect: true,
      enableReadyCheck: false,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
    });
    clients.push(connection);
    return connection;
  }
  try {
    const anonymous = client();
    await expect(anonymous.ping()).rejects.toThrow("NOAUTH");
    const publisher = client("orchestrator", publisherPassword);
    const subscriber = client("proxy", proxyPassword);
    const listener = client("proxy", proxyPassword);
    expect(await publisher.ping()).toBe("PONG");
    expect(await subscriber.ping()).toBe("PONG");
    await expect(publisher.set("arbitrary", "value")).rejects.toThrow("NOPERM");
    await expect(publisher.publish("other-channel", "value")).rejects.toThrow("NOPERM");
    await expect(subscriber.publish("minecraft:proxy:registry", "value")).rejects.toThrow("NOPERM");
    await expect(subscriber.get("arbitrary")).rejects.toThrow("NOPERM");
    await expect(subscriber.subscribe("other-channel")).rejects.toThrow("NOPERM");
    await expect(publisher.subscribe("minecraft:proxy:registry")).rejects.toThrow("NOPERM");
    expect(await listener.subscribe("minecraft:proxy:registry", "minecraft:proxy:transfers")).toBe(
      2,
    );
    for (const channel of ["minecraft:proxy:registry", "minecraft:proxy:transfers"]) {
      const message = new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Redis notification was not received")),
          2_000,
        );
        listener.once("message", (receivedChannel, payload) => {
          clearTimeout(timeout);
          resolve(`${receivedChannel}:${payload}`);
        });
      });
      expect(await publisher.publish(channel, "control-event")).toBe(1);
      expect(await message).toBe(`${channel}:control-event`);
    }
    expect(await publisher.quit()).toBe("OK");
    expect(await subscriber.quit()).toBe("OK");
    await listener.unsubscribe();
    expect(await listener.quit()).toBe("OK");
  } finally {
    for (const connection of clients) connection.disconnect();
    await container.stop();
  }
}, 60_000);
