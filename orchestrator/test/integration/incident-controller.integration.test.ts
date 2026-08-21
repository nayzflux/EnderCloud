import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq, sql } from "drizzle-orm";
import { loadConfig, type AppConfig } from "../../src/config.ts";
import { createDatabase } from "../../src/db/client.ts";
import { migrateDatabase } from "../../src/db/migrate.ts";
import {
  commands,
  events,
  executionHosts,
  gameSessions,
  operationalIncidents,
  serverGroups,
  serverGroupVariants,
  serverInstances,
  serverVariantLayers,
  serverVariants,
  templateLayers,
  transferCommands,
} from "../../src/db/schema.ts";
import type { Logger } from "../../src/logger.ts";
import { IncidentController } from "../../src/services/incident-controller.ts";

let container: StartedPostgreSqlContainer | undefined;
let sqlClient: ReturnType<typeof createDatabase>["sql"];
let db: ReturnType<typeof createDatabase>["db"];
let config: AppConfig;
let opened: Record<string, unknown>[];
let resolved: Record<string, unknown>[];

const logger = {
  debug: () => {},
  error: () => {},
  warn: (_message: string, fields: Record<string, unknown>) => opened.push(fields),
  info: (_message: string, fields: Record<string, unknown>) => resolved.push(fields),
} as unknown as Logger;

async function seedGroup({ minimum = 0, warm = 0 }: { minimum?: number; warm?: number } = {}) {
  const groupId = "incident-group";
  const variantId = "incident-variant";
  const runtime = {
    image: "itzg/minecraft-server:java25",
    cpu: 2,
    memoryBytes: 1024 ** 3,
    environment: {},
  };
  await db.insert(serverGroups).values({
    id: groupId,
    type: "hub",
    enabled: true,
    minimumInstances: minimum,
    maximumInstances: 8,
    minimumWarmInstances: warm,
    maximumWarmInstances: 8,
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
    checksum: "none",
    runtimePatch: runtime,
    fileSummary: { fileCount: 0, totalBytes: 0, roots: [] },
  });
  await db.insert(serverVariants).values({ id: variantId, revision: 1, checksum: "none", runtimeSpec: runtime });
  await db.insert(serverVariantLayers).values({ variantId, layerId: variantId, ordinal: 0 });
  await db.insert(serverGroupVariants).values({ groupId, variantId, enabled: true, selectionWeight: 100 });
  return { groupId, variantId };
}

async function seedHost(id = "incident-host", cpu = 16) {
  await db.insert(executionHosts).values({
    id,
    controlUrl: `http://${id}:8090`,
    gameAddress: "10.0.0.10",
    allocatableCpu: cpu,
    allocatableMemoryBytes: 16 * 1024 ** 3,
    healthState: "ONLINE",
    adminState: "ACTIVE",
    agentVersion: "test",
    lastHeartbeatAt: new Date(),
    lastControlContactAt: new Date(),
  });
}

describe("persistent operational incidents", () => {
  beforeAll(async () => {
    const uri = process.env.TEST_DATABASE_URL ?? await (async () => {
      container = await new PostgreSqlContainer("postgres:15-alpine").start();
      return container.getConnectionUri();
    })();
    await migrateDatabase(uri);
    const client = createDatabase(uri);
    sqlClient = client.sql;
    db = client.db;
    config = {
      ...loadConfig(),
      databaseUrl: uri,
      incidentBlockedAfterMs: 30_000,
      incidentFailureThreshold: 3,
      incidentFailureWindowMs: 900_000,
      incidentHostRecoveryAfterMs: 60_000,
      incidentHistoryRetentionMs: 7_776_000_000,
      maxInstanceRetries: 2,
    };
  }, 30_000);

  beforeEach(async () => {
    await sqlClient`TRUNCATE TABLE operational_incidents, template_layers, server_groups, execution_hosts, events CASCADE`;
    opened = [];
    resolved = [];
  });

  afterAll(async () => {
    if (sqlClient) await sqlClient.end();
    if (container) await container.stop();
  });

  test("persists pending capacity, opens once after 30s, resolves and retains history", async () => {
    await seedGroup({ minimum: 4, warm: 4 });
    await seedHost("small-host", 4);
    await new IncidentController(db, config, logger).tick();

    let stored = await db.select().from(operationalIncidents);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.state).toBe("PENDING");
    expect((await new IncidentController(db, config, logger).list({})).incidents).toHaveLength(0);

    await db.update(operationalIncidents).set({
      firstObservedAt: new Date(Date.now() - 31_000),
    }).where(eq(operationalIncidents.fingerprint, "capacity:incident-group"));
    const recreated = new IncidentController(db, config, logger);
    await recreated.tick();
    await recreated.tick();

    const active = await recreated.list({ kind: "CAPACITY_BLOCKED" });
    expect(active.incidents).toHaveLength(1);
    expect(active.incidents[0]).toMatchObject({
      cause: "INSUFFICIENT_CPU",
      occurrenceCount: 1,
      evidence: { neededInstanceCount: 4, requiredCpu: 8, aggregateFreeCpu: 4 },
    });
    expect(opened).toHaveLength(1);

    await seedHost("large-host", 8);
    await recreated.tick();
    expect((await recreated.list({})).incidents).toHaveLength(0);
    expect((await recreated.list({ status: "resolved" })).incidents).toHaveLength(1);
    expect(resolved).toHaveLength(1);

    await db.update(operationalIncidents).set({
      resolvedAt: new Date(Date.now() - 91 * 24 * 60 * 60 * 1_000),
    }).where(eq(operationalIncidents.state, "RESOLVED"));
    await recreated.prune();
    stored = await db.select().from(operationalIncidents);
    expect(stored).toHaveLength(0);
  });

  test("aggregates variant, session, transfer and command failure loops without duplicates", async () => {
    const { groupId, variantId } = await seedGroup();
    await seedHost();
    const instanceIds = ["failed-instance-1", "failed-instance-2", "failed-instance-3"];
    await db.insert(serverInstances).values(instanceIds.map((id) => ({
      id,
      groupId,
      variantId,
      lifecycleState: "FAILED" as const,
      availabilityState: "OPEN" as const,
    })));
    await db.insert(events).values(instanceIds.map((aggregateId, index) => ({
      id: `failure-event-${index}`,
      aggregateType: "instance",
      aggregateId,
      type: "INSTANCE_FAILED",
      payload: { reason: "STARTUP_TIMEOUT" },
    })));
    await db.insert(gameSessions).values({
      id: "failed-session",
      groupId,
      state: "FAILED",
      retryCount: 2,
    });
    await db.insert(transferCommands).values(instanceIds.map((instanceId, index) => ({
      id: `expired-transfer-${index}`,
      instanceId,
      payload: { players: [] },
      state: "EXPIRED",
      attempts: 2,
      expiresAt: new Date(Date.now() - 1_000),
      completedAt: new Date(),
    })));
    await db.insert(commands).values(instanceIds.map((instanceId, index) => ({
      id: `failed-command-${index}`,
      instanceId,
      operation: "DELETE",
      state: "FAILED" as const,
      attempts: 2,
      completedAt: new Date(),
      lastError: "agent unavailable",
    })));

    const controller = new IncidentController(db, config, logger);
    await controller.tick();
    await controller.tick();
    const active = await controller.list({ status: "active", limit: 200 });
    expect(new Set(active.incidents.map((incident) => incident.kind))).toEqual(new Set([
      "INSTANCE_FAILURE_LOOP",
      "SESSION_RETRIES_EXHAUSTED",
      "TRANSFER_FAILURE_LOOP",
      "COMMAND_FAILURE_LOOP",
    ]));
    const failureLoop = active.incidents.find((incident) => incident.kind === "INSTANCE_FAILURE_LOOP");
    expect(failureLoop?.occurrenceCount).toBe(3);
    expect(new Set(failureLoop?.evidence.instanceIds as string[])).toEqual(new Set(instanceIds));
    expect(await db.select().from(operationalIncidents)).toHaveLength(4);
    expect(opened).toHaveLength(4);

    const expired = new Date(Date.now() - config.incidentFailureWindowMs - 1_000);
    await db.update(events).set({ createdAt: expired });
    await db.update(gameSessions).set({ updatedAt: expired });
    await db.update(transferCommands).set({ completedAt: expired });
    await db.update(commands).set({ completedAt: expired });
    await controller.tick();
    expect((await controller.list({})).incidents).toHaveLength(0);
    expect((await controller.list({ status: "resolved", limit: 200 })).incidents).toHaveLength(4);
  });

  test("tracks host state, maintenance replacement and three consecutive loop failures", async () => {
    const { groupId, variantId } = await seedGroup();
    await seedHost();
    const controller = new IncidentController(db, config, logger);

    await db.update(executionHosts).set({ healthState: "OFFLINE" }).where(eq(executionHosts.id, "incident-host"));
    await controller.tick();
    expect((await controller.list({ kind: "HOST_UNAVAILABLE" })).incidents).toHaveLength(1);
    await db.update(executionHosts).set({ healthState: "ONLINE" }).where(eq(executionHosts.id, "incident-host"));
    await controller.tick();
    expect((await controller.list({ kind: "HOST_UNAVAILABLE" })).incidents).toHaveLength(0);

    await db.update(executionHosts).set({ healthState: "RECOVERING" }).where(eq(executionHosts.id, "incident-host"));
    await controller.tick();
    expect((await controller.list({ kind: "HOST_RECOVERY_STUCK" })).incidents).toHaveLength(0);
    await db.update(operationalIncidents).set({ firstObservedAt: new Date(Date.now() - 61_000) })
      .where(eq(operationalIncidents.fingerprint, "host-health:incident-host"));
    await new IncidentController(db, config, logger).tick();
    expect((await controller.list({ kind: "HOST_RECOVERY_STUCK" })).incidents).toHaveLength(1);
    await db.update(executionHosts).set({ healthState: "ONLINE" }).where(eq(executionHosts.id, "incident-host"));
    await controller.tick();
    expect((await controller.list({ kind: "HOST_RECOVERY_STUCK" })).incidents).toHaveLength(0);

    await db.insert(serverInstances).values({
      id: "maintenance-source",
      groupId,
      variantId,
      hostId: "incident-host",
      reservedCpu: 2,
      reservedMemoryBytes: 1024 ** 3,
      lifecycleState: "RUNNING",
      availabilityState: "OPEN",
    });
    await db.update(executionHosts).set({ adminState: "DRAINING" }).where(eq(executionHosts.id, "incident-host"));
    await controller.tick();
    await db.update(operationalIncidents).set({ firstObservedAt: new Date(Date.now() - 31_000) })
      .where(eq(operationalIncidents.fingerprint, "host-maintenance:incident-host"));
    await new IncidentController(db, config, logger).tick();
    expect((await controller.list({ kind: "HOST_MAINTENANCE_BLOCKED" })).incidents).toHaveLength(1);
    await db.insert(serverInstances).values({
      id: "maintenance-replacement",
      groupId,
      variantId,
      lifecycleState: "CREATING",
      availabilityState: "OPEN",
      replacesInstanceId: "maintenance-source",
      replacementReason: "HOST_MAINTENANCE",
    });
    await controller.tick();
    expect((await controller.list({ kind: "HOST_MAINTENANCE_BLOCKED" })).incidents).toHaveLength(0);

    await controller.recordLoopFailure("capacity", new Error("one"));
    await controller.recordLoopFailure("capacity", new Error("two"));
    expect((await controller.list({ kind: "CONTROL_LOOP_FAILURE" })).incidents).toHaveLength(0);
    await controller.recordLoopFailure("capacity", new Error("three"));
    const loop = await controller.list({ kind: "CONTROL_LOOP_FAILURE" });
    expect(loop.incidents[0]).toMatchObject({ occurrenceCount: 3, cause: "SCHEDULED_TASK_FAILED" });
    await controller.recordLoopSuccess("capacity");
    expect((await controller.list({ kind: "CONTROL_LOOP_FAILURE" })).incidents).toHaveLength(0);
  });
});
