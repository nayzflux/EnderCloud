import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { createDatabase } from "../../src/db/client.ts";
import { migrateDatabase } from "../../src/db/migrate.ts";
import {
  executionHosts,
  serverGroups,
  serverGroupVariants,
  serverInstances,
  serverVariantLayers,
  serverVariants,
  templateLayers,
} from "../../src/db/schema.ts";
import { DashboardService } from "../../src/services/dashboard-service.ts";

let container: StartedPostgreSqlContainer | undefined;
let sqlClient: ReturnType<typeof createDatabase>["sql"];
let db: ReturnType<typeof createDatabase>["db"];

describe("dashboard host reporting", () => {
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

  afterAll(async () => {
    if (sqlClient) await sqlClient.end();
    if (container) await container.stop();
  });

  test("aggregates physical reservations and active instances by host", async () => {
    const gibibyte = 1024 ** 3;
    const runtime = {
      image: "itzg/minecraft-server:java25",
      cpu: 2,
      memoryBytes: 2 * gibibyte,
      environment: {},
    };

    await db.insert(executionHosts).values({
      id: "reporting-host",
      controlUrl: "http://reporting-host:8090",
      gameAddress: "10.0.0.10",
      allocatableCpu: 8,
      allocatableMemoryBytes: 16 * gibibyte,
      healthState: "ONLINE",
      adminState: "ACTIVE",
      agentVersion: "test",
      lastHeartbeatAt: new Date(),
    });
    await db.insert(serverGroups).values({
      id: "reporting-group",
      type: "hub",
      maximumInstances: 8,
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
      id: "reporting-variant",
      templatePath: "none",
      checksum: "checksum",
      runtimePatch: runtime,
      fileSummary: { fileCount: 0, totalBytes: 0, roots: [] },
    });
    await db.insert(serverVariants).values({
      id: "reporting-variant",
      revision: 1,
      checksum: "checksum",
      runtimeSpec: runtime,
    });
    await db.insert(serverVariantLayers).values({
      variantId: "reporting-variant",
      layerId: "reporting-variant",
      ordinal: 0,
    });
    await db.insert(serverGroupVariants).values({
      groupId: "reporting-group",
      variantId: "reporting-variant",
      selectionWeight: 100,
    });
    await db.insert(serverInstances).values([
      {
        id: "running-instance",
        groupId: "reporting-group",
        variantId: "reporting-variant",
        hostId: "reporting-host",
        reservedCpu: 2,
        reservedMemoryBytes: 2 * gibibyte,
        lifecycleState: "RUNNING",
        availabilityState: "OPEN",
      },
      {
        id: "failed-instance",
        groupId: "reporting-group",
        variantId: "reporting-variant",
        hostId: "reporting-host",
        reservedCpu: 1,
        reservedMemoryBytes: gibibyte,
        lifecycleState: "FAILED",
        availabilityState: "OPEN",
      },
      {
        id: "stopped-instance",
        groupId: "reporting-group",
        variantId: "reporting-variant",
        hostId: "reporting-host",
        reservedCpu: 4,
        reservedMemoryBytes: 4 * gibibyte,
        lifecycleState: "STOPPED",
        availabilityState: "OPEN",
      },
    ]);

    const snapshot = await new DashboardService(db).getCluster();

    expect(snapshot.hosts).toHaveLength(1);
    expect(snapshot.hosts[0]).toMatchObject({
      id: "reporting-host",
      activeInstanceCount: 1,
      reservedCpu: 3,
      reservedMemoryBytes: 3 * gibibyte,
    });
  });
});
