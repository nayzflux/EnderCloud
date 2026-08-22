import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { and, asc, eq, inArray } from "drizzle-orm";
import { createDatabase } from "../../src/db/client.ts";
import { migrateDatabase } from "../../src/db/migrate.ts";
import {
  commands,
  executionHosts,
  serverGroups,
  serverGroupVariants,
  serverInstances,
  serverVariantLayers,
  serverVariants,
  templateLayers,
  variantStartStates,
} from "../../src/db/schema.ts";
import type { Executor } from "../../src/executor/executor.ts";
import { Logger } from "../../src/logger.ts";
import type { InstanceController } from "../../src/services/instance-controller.ts";
import { InstanceStartWorker } from "../../src/services/instance-start-worker.ts";
import { VariantStartController } from "../../src/services/variant-start-controller.ts";
import { VariantSelector } from "../../src/services/variant-selector.ts";

let container: StartedPostgreSqlContainer | undefined;
let sqlClient: ReturnType<typeof createDatabase>["sql"];
let db: ReturnType<typeof createDatabase>["db"];

const logger = new Logger("error", { sink: () => {} });
const groupId = "startup-group";
const variantId = "startup-variant";
const hostId = "startup-host";

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for startup worker state");
    await Bun.sleep(5);
  }
}

async function seedBase(): Promise<void> {
  const runtime = {
    image: "itzg/minecraft-server:java25",
    cpu: 1,
    memoryBytes: 1024 ** 3,
    environment: {},
  };
  await db.insert(serverGroups).values({
    id: groupId,
    type: "hub",
    enabled: true,
    minimumInstances: 0,
    maximumInstances: 10,
    minimumWarmInstances: 0,
    maximumWarmInstances: 10,
    maximumPlayersPerInstance: 100,
    targetPlayersPerInstance: 70,
    startupTimeoutMs: 90_000,
    drainTimeoutMs: 300_000,
    cancelledDrainTimeoutMs: 10_000,
    shutdownTimeoutMs: 20_000,
    transferTimeoutMs: 20_000,
    playerStaleTimeoutMs: 30_000,
    instanceLifetimeMs: 14_400_000,
  });
  await db.insert(templateLayers).values({
    id: variantId,
    templatePath: "none",
    checksum: "checksum",
    runtimePatch: runtime,
    fileSummary: { fileCount: 0, totalBytes: 0, roots: [] },
  });
  await db.insert(serverVariants).values({ id: variantId, revision: 1, checksum: "checksum", runtimeSpec: runtime });
  await db.insert(serverVariantLayers).values({ variantId, layerId: variantId, ordinal: 0 });
  await db.insert(serverGroupVariants).values({ groupId, variantId, enabled: true, selectionWeight: 100 });
  await db.insert(executionHosts).values({
    id: hostId,
    controlUrl: "http://startup-host:8090",
    gameAddress: "10.0.0.10",
    allocatableCpu: 16,
    allocatableMemoryBytes: 16 * 1024 ** 3,
    healthState: "ONLINE",
    adminState: "ACTIVE",
    agentVersion: "test",
    lastHeartbeatAt: new Date(),
  });
}

async function seedCreates(count: number, state: "PENDING" | "RUNNING" = "PENDING"): Promise<void> {
  const createdAt = Date.now() - count * 1_000;
  for (let index = 0; index < count; index += 1) {
    const instanceId = `startup-instance-${index}`;
    await db.insert(serverInstances).values({
      id: instanceId,
      groupId,
      variantId,
      variantRevision: 1,
      hostId,
      reservedCpu: 1,
      reservedMemoryBytes: 1024 ** 3,
      lifecycleState: "CREATING",
      availabilityState: "OPEN",
      createdAt: new Date(createdAt + index * 100),
    });
    await db.insert(commands).values({
      id: `startup-command-${index}`,
      instanceId,
      operation: "CREATE",
      state,
      createdAt: new Date(createdAt + index * 100),
      ...(state === "RUNNING" ? { startedAt: new Date() } : {}),
    });
  }
}

describe("durable instance startup", () => {
  beforeAll(async () => {
    const uri = process.env.TEST_DATABASE_URL ?? await (async () => {
      container = await new PostgreSqlContainer("postgres:15-alpine").start();
      return container.getConnectionUri();
    })();
    await migrateDatabase(uri);
    const client = createDatabase(uri);
    sqlClient = client.sql;
    db = client.db;
  }, 30_000);

  beforeEach(async () => {
    await sqlClient`TRUNCATE TABLE template_layers, server_groups, execution_hosts CASCADE`;
    await seedBase();
  });

  afterAll(async () => {
    if (sqlClient) await sqlClient.end();
    if (container) await container.stop();
  });

  test("claims CREATE commands in FIFO order without exceeding global concurrency", async () => {
    await seedCreates(5);
    const started: string[] = [];
    const releases: Array<() => void> = [];
    let active = 0;
    let maximumActive = 0;
    const instances = {
      executeCreate: async (_instanceId: string, commandId: string) => {
        started.push(commandId);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active -= 1;
        await db.update(commands).set({ state: "SUCCEEDED", completedAt: new Date() })
          .where(eq(commands.id, commandId));
      },
    } as unknown as InstanceController;
    const worker = new InstanceStartWorker(db, instances, {} as Executor, logger, 2);

    await worker.tick();
    await waitFor(() => started.length === 2);
    expect(started).toEqual(["startup-command-0", "startup-command-1"]);
    expect(maximumActive).toBe(2);

    while (started.length < 5) {
      const previous = started.length;
      releases.splice(0).forEach((release) => release());
      await waitFor(() => started.length > previous);
    }
    releases.splice(0).forEach((release) => release());
    await waitFor(async () => {
      const rows = await db.select({ state: commands.state }).from(commands)
        .where(eq(commands.operation, "CREATE"));
      return rows.every((row) => row.state === "SUCCEEDED");
    });
    await worker.stop();

    expect(started).toEqual([
      "startup-command-0",
      "startup-command-1",
      "startup-command-2",
      "startup-command-3",
      "startup-command-4",
    ]);
    expect(maximumActive).toBe(2);
  });

  test("recovers RUNNING work and returns interrupted shutdown work to PENDING", async () => {
    await seedCreates(2, "RUNNING");
    let release: (() => void) | undefined;
    const executor = { cancelPending: () => release?.() } as Executor;
    const instances = {
      executeCreate: async () => new Promise<void>((resolve) => { release = resolve; }),
    } as unknown as InstanceController;
    const worker = new InstanceStartWorker(db, instances, executor, logger, 1);

    expect(await worker.recoverInterrupted()).toBe(2);
    await worker.tick();
    await waitFor(async () => (await db.select().from(commands)
      .where(eq(commands.state, "RUNNING"))).length === 1);
    await worker.stop();

    const rows = await db.select({ state: commands.state, startedAt: commands.startedAt })
      .from(commands).orderBy(asc(commands.createdAt));
    expect(rows.every((row) => row.state === "PENDING" && row.startedAt === null)).toBe(true);
  });

  test("blocks the sixth startup failure, bounds diagnostics and resets manually", async () => {
    const stopped: string[] = [];
    const deleted: string[] = [];
    const executor = {
      getInstanceLogs: async () => Array.from({ length: 300 }, (_, index) => `${index}:${"x".repeat(400)}`).join("\n"),
      stopInstance: async ({ instanceId }: { instanceId: string }) => { stopped.push(instanceId); },
      deleteInstance: async ({ instanceId }: { instanceId: string }) => { deleted.push(instanceId); },
    } as unknown as Executor;
    const policy = new VariantStartController(db, executor, {
      instanceStartRetryLimit: 5,
      instanceStartRetryBaseDelayMs: 1_000,
    }, logger);

    const delays: number[] = [];
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      const instanceId = `failed-startup-${attempt}`;
      await db.insert(serverInstances).values({
        id: instanceId,
        groupId,
        variantId,
        variantRevision: 1,
        hostId,
        lifecycleState: "FAILED",
        availabilityState: "OPEN",
      });
      if (attempt > 1) {
        await db.update(variantStartStates).set({
          state: "PROBING",
          probeInstanceId: instanceId,
          nextRetryAt: null,
        }).where(and(
          eq(variantStartStates.groupId, groupId),
          eq(variantStartStates.variantId, variantId),
          eq(variantStartStates.variantRevision, 1),
        ));
      }
      const before = Date.now();
      const status = await policy.recordFailure(instanceId, "STARTUP_TIMEOUT");
      if (status?.nextRetryAt) delays.push(new Date(status.nextRetryAt).getTime() - before);
      if (attempt < 6) expect(status?.state).toBe("BACKING_OFF");
      else expect(status?.state).toBe("BLOCKED");
      if (attempt < 6) {
        await db.update(serverInstances).set({ lifecycleState: "STOPPED" })
          .where(eq(serverInstances.id, instanceId));
      }
    }
    expect(delays.map((delay) => Math.round(delay / 1_000))).toEqual([1, 2, 4, 8, 16]);

    const retained = await db.select().from(serverInstances)
      .where(eq(serverInstances.id, "failed-startup-6"));
    expect(retained[0]?.runtimeRetained).toBe(true);
    expect(Buffer.byteLength(retained[0]?.failureLogTail ?? "")).toBeLessThanOrEqual(65_536);
    expect((retained[0]?.failureLogTail ?? "").split("\n").length).toBeLessThanOrEqual(200);
    expect(stopped).toEqual(["failed-startup-6"]);

    const request = await policy.requestReset(groupId, variantId, 1);
    expect(request.status).toBe("ACCEPTED");
    expect(request.status === "ACCEPTED" && request.startup.state).toBe("RESETTING");
    const repeated = await policy.requestReset(groupId, variantId, 1);
    expect(repeated.status).toBe("ACCEPTED");
    await policy.reconcile();
    expect(await db.select().from(variantStartStates)).toHaveLength(0);
    expect(deleted).toEqual(["failed-startup-6"]);
    const cleaned = await db.select().from(serverInstances)
      .where(eq(serverInstances.id, "failed-startup-6"));
    expect(cleaned[0]?.lifecycleState).toBe("STOPPED");
  });

  test("cancels queued siblings and suppresses failures from already-running siblings", async () => {
    await db.insert(serverInstances).values([
      {
        id: "first-concurrent-failure",
        groupId,
        variantId,
        variantRevision: 1,
        hostId,
        lifecycleState: "FAILED",
        availabilityState: "OPEN",
      },
      {
        id: "queued-sibling-start",
        groupId,
        variantId,
        variantRevision: 1,
        hostId,
        lifecycleState: "CREATING",
        availabilityState: "OPEN",
      },
      {
        id: "running-sibling-failure",
        groupId,
        variantId,
        variantRevision: 1,
        hostId,
        lifecycleState: "FAILED",
        availabilityState: "OPEN",
      },
    ]);
    await db.insert(commands).values({
      id: "queued-sibling-command",
      instanceId: "queued-sibling-start",
      operation: "CREATE",
      state: "PENDING",
    });
    const policy = new VariantStartController(db, {} as Executor, {
      instanceStartRetryLimit: 5,
      instanceStartRetryBaseDelayMs: 1_000,
    }, logger);

    expect((await policy.recordFailure("first-concurrent-failure", "CREATE_FAILED"))?.failureCount).toBe(1);
    expect((await db.select().from(commands)
      .where(eq(commands.id, "queued-sibling-command")))[0]?.state).toBe("CANCELLED");
    expect((await db.select().from(serverInstances)
      .where(eq(serverInstances.id, "queued-sibling-start")))[0]?.lifecycleState).toBe("STOPPED");
    expect((await policy.recordFailure("running-sibling-failure", "CREATE_FAILED"))?.failureCount).toBe(1);
    expect((await db.select().from(variantStartStates))[0]?.failureCount).toBe(1);
  });

  test("allows one degraded probe and clears the policy on SERVER_READY", async () => {
    await db.insert(serverInstances).values([
      {
        id: "startup-probe-one",
        groupId,
        variantId,
        variantRevision: 1,
        hostId,
        lifecycleState: "CREATING",
        availabilityState: "OPEN",
      },
      {
        id: "startup-probe-two",
        groupId,
        variantId,
        variantRevision: 1,
        hostId,
        lifecycleState: "CREATING",
        availabilityState: "OPEN",
      },
    ]);
    await db.insert(variantStartStates).values({
      groupId,
      variantId,
      variantRevision: 1,
      state: "BACKING_OFF",
      failureCount: 1,
      nextRetryAt: new Date(Date.now() - 1_000),
      lastFailureReason: "CREATE_FAILED",
      lastFailureAt: new Date(),
    });
    const policy = new VariantStartController(db, {} as Executor, {
      instanceStartRetryLimit: 5,
      instanceStartRetryBaseDelayMs: 1_000,
    }, logger);

    const first = await db.transaction((tx) =>
      policy.reserveAttempt(tx, groupId, variantId, 1, "startup-probe-one")
    );
    const second = await db.transaction((tx) =>
      policy.reserveAttempt(tx, groupId, variantId, 1, "startup-probe-two")
    );
    expect(first).toBe(true);
    expect(second).toBe(false);

    await policy.markReady("startup-probe-one");
    expect(await db.select().from(variantStartStates)).toHaveLength(0);
  });

  test("a new revision automatically clears the retained failure policy", async () => {
    await db.insert(serverInstances).values([
      {
        id: "old-revision-failure",
        groupId,
        variantId,
        variantRevision: 1,
        hostId,
        lifecycleState: "FAILED",
        availabilityState: "OPEN",
        runtimeRetained: true,
      },
      {
        id: "old-revision-probe",
        groupId,
        variantId,
        variantRevision: 1,
        hostId,
        lifecycleState: "CREATING",
        availabilityState: "OPEN",
      },
    ]);
    await db.insert(commands).values({
      id: "old-revision-command",
      instanceId: "old-revision-probe",
      operation: "CREATE",
      state: "PENDING",
    });
    await db.insert(variantStartStates).values({
      groupId,
      variantId,
      variantRevision: 1,
      state: "PROBING",
      failureCount: 5,
      probeInstanceId: "old-revision-probe",
      lastFailedInstanceId: "old-revision-failure",
      lastFailureReason: "CREATE_FAILED",
      lastFailureAt: new Date(),
    });
    await db.update(serverVariants).set({ revision: 2 }).where(eq(serverVariants.id, variantId));
    const deleted: string[] = [];
    let cleanupFails = true;
    const executor = {
      stopInstance: async () => {},
      deleteInstance: async ({ instanceId }: { instanceId: string }) => {
        if (cleanupFails) throw new Error("cleanup unavailable");
        deleted.push(instanceId);
      },
    } as unknown as Executor;
    const policy = new VariantStartController(db, executor, {
      instanceStartRetryLimit: 5,
      instanceStartRetryBaseDelayMs: 1_000,
    }, logger);

    await policy.reconcile();
    expect((await db.select().from(variantStartStates))[0]?.state).toBe("RESETTING");
    expect(await new VariantSelector(db).select(groupId)).toBeNull();
    expect((await db.select().from(commands)
      .where(eq(commands.id, "old-revision-command")))[0]?.state).toBe("CANCELLED");
    cleanupFails = false;
    await policy.reconcile();
    expect(await db.select().from(variantStartStates)).toHaveLength(0);
    expect(deleted).toEqual(["old-revision-failure"]);
    expect((await new VariantSelector(db).select(groupId))?.revision).toBe(2);
  });
});
