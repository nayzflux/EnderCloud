import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq, sql } from "drizzle-orm";
import { createDatabase } from "../../src/db/client.ts";
import { migrateDatabase } from "../../src/db/migrate.ts";
import * as schema from "../../src/db/schema.ts";
import type { Executor, InstanceSpec, RuntimeInstance } from "@endercloud/contracts/executor";
import type { RedisEventBus } from "../../src/events/redis-bus.ts";
import { Logger } from "@endercloud/runtime/logger";
import { CapacityController } from "../../src/modules/capacity/controller.ts";
import { DashboardService } from "../../src/modules/dashboard/queries.ts";
import { HostMaintenanceController } from "../../src/modules/hosts/maintenance.ts";
import { HostService } from "../../src/modules/hosts/service.ts";
import { HubRouter } from "../../src/modules/routing/hubs.ts";
import { InstanceController } from "../../src/modules/instances/lifecycle.ts";
import { ProxyService } from "../../src/modules/proxies/service.ts";
import { Reconciler } from "../../src/modules/hosts/reconciler.ts";
import { SessionController } from "../../src/modules/sessions/controller.ts";
import { TransferService } from "../../src/modules/transfers/service.ts";
import { VariantSelector } from "../../src/modules/instances/variant-selector.ts";

let container: StartedPostgreSqlContainer | undefined;
let database: ReturnType<typeof createDatabase>;
let instances: InstanceController;
let proxies: ProxyService;
let hosts: HostService;
let executor: Executor;
let transfers: TransferService;
const logger = new Logger("error", { sink: () => {} });
const runtime = new Map<string, RuntimeInstance>();
const creates: InstanceSpec[] = [];
const registry: { type: string; payload: unknown }[] = [];

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:18.1-alpine").start();
  const uri = container.getConnectionUri();
  await migrateDatabase(uri);
  database = createDatabase(uri);
}, 60_000);

afterAll(async () => {
  if (database) await database.sql.end();
  if (container) await container.stop();
});

beforeEach(async () => {
  await database.db.execute(sql`TRUNCATE server_groups, template_layers, execution_hosts, proxy_heartbeats CASCADE`);
  runtime.clear();
  creates.length = 0;
  registry.length = 0;
  const db = database.db;
  const bus = {
    publishRegistry: async (type: string, payload: unknown) => { registry.push({ type, payload }); },
    publishTransfer: async () => {},
  } as unknown as RedisEventBus;
  executor = {
    createInstance: async (spec) => {
      creates.push(spec);
      runtime.set(spec.instanceId, {
        hostId: spec.hostId, instanceId: spec.instanceId, groupId: spec.groupId,
        variantId: spec.variantId, containerId: spec.instanceId, running: true, status: "Up",
      });
      return { containerId: spec.instanceId, runtimePath: "/runtime/" + spec.instanceId, endpoint: "10.0.0.10:" + (25700 + creates.length) };
    },
    stopInstance: async (target) => { runtime.delete(target.instanceId); },
    deleteInstance: async (target) => { runtime.delete(target.instanceId); },
    deleteOrphanInstance: async () => ({ containerRemoved: true, runtimeDirectoryRemoved: true }),
    inspectInstance: async (target) => ({ exists: runtime.has(target.instanceId), running: runtime.has(target.instanceId) }),
    listManagedInstances: async (hostId) => [...runtime.values()].filter((instance) => instance.hostId === hostId),
  };
  hosts = new HostService(db, logger);
  transfers = new TransferService(db, bus, logger);
  instances = new InstanceController(db, executor, new VariantSelector(db), bus, transfers, new HubRouter(db, transfers), logger, undefined, hosts);
  proxies = new ProxyService(db, instances);
  for (const [id, proxy] of [["paper-host", false], ["proxy-host", true]] as const) {
    await db.insert(schema.executionHosts).values({
      id, controlUrl: "http://" + id + ":8090", gameAddress: "10.0.0.10",
      allocatableCpu: 8, allocatableMemoryBytes: 8 * 1024 ** 3, healthState: "ONLINE", adminState: "ACTIVE",
      agentVersion: "test", lastHeartbeatAt: new Date(),
      ...(proxy ? { proxyAddress: "10.0.0.10", proxyPortStart: 25700, proxyPortEnd: 25709 } : {}),
    });
  }
  for (const [id, type, count] of [["edge-proxies", "proxy", 2], ["hub", "hub", 1]] as const) {
    const variantId = id + "-main";
    const spec = { image: "itzg/mc-proxy:java25", cpu: 1, memoryBytes: 512 * 1024 ** 2, environment: {}, dataDirectory: "/server" };
    await db.insert(schema.serverGroups).values({
      id, type, minimumInstances: count, maximumInstances: count, minimumWarmInstances: count, maximumWarmInstances: count,
      startupTimeoutMs: 90_000, drainTimeoutMs: 900_000, cancelledDrainTimeoutMs: 10_000,
      shutdownTimeoutMs: 20_000, transferTimeoutMs: 20_000, playerStaleTimeoutMs: 30_000,
      ...(type === "hub" ? { maximumPlayersPerInstance: 100, targetPlayersPerInstance: 70 } : {}),
    });
    await db.insert(schema.templateLayers).values({ id: variantId, templatePath: "none", checksum: "checksum", runtimePatch: spec, fileSummary: { fileCount: 0, totalBytes: 0, roots: [] } });
    await db.insert(schema.serverVariants).values({ id: variantId, revision: 1, checksum: "checksum", runtimeSpec: spec });
    await db.insert(schema.serverVariantLayers).values({ variantId, layerId: variantId, ordinal: 0 });
    await db.insert(schema.serverGroupVariants).values({ groupId: id, variantId, selectionWeight: 100 });
  }
});

async function startPool(): Promise<string[]> {
  await new CapacityController(database.db, instances, logger).tick();
  const commands = await database.db.select().from(schema.commands).where(eq(schema.commands.state, "PENDING"));
  for (const command of commands) await instances.executeCreate(command.instanceId!, command.id);
  const rows = await database.db.select().from(schema.serverInstances);
  for (const instance of rows) {
    if (instance.groupId === "hub") await instances.handlePaperEvent(instance.id, { type: "SERVER_READY" });
    else await proxies.heartbeat(instance.id, { ready: true, playerCount: 0, acceptingConnections: false });
  }
  return rows.filter((instance) => instance.groupId === "edge-proxies").map((instance) => instance.id);
}

function reconciler() {
  return new Reconciler(database.db, executor, instances, hosts, logger, 30_000);
}

async function tickSessions() {
  await new SessionController(
    database.db, instances, transfers, new HubRouter(database.db, transfers), logger,
  ).tick();
}

test("two fixed proxies and a hub stay isolated in registry, transfers and dashboard counts", async () => {
  const ids = await startPool();
  expect(ids).toHaveLength(2);
  expect(creates.filter((spec) => spec.instanceType === "proxy").every((spec) => spec.hostId === "proxy-host")).toBeTrue();
  for (const id of ids) await proxies.heartbeat(id, { ready: true, playerCount: 5, acceptingConnections: true });
  const hub = (await instances.listProxyServers())[0]!;
  await instances.handlePaperEvent(hub.instanceId, { type: "PLAYER_JOINED", playerId: "00000000-0000-0000-0000-000000000001" });
  expect(await instances.listProxyServers()).toHaveLength(1);
  expect(registry.every((event) => !(event.payload as { groupType?: string }).groupType || (event.payload as { groupType?: string }).groupType === "hub")).toBeTrue();
  expect((await proxies.list()).every((proxy) => proxy.acceptingConnections)).toBeTrue();
  const dashboard = await new DashboardService(database.db).getCluster();
  expect(dashboard.summary.playersOnline).toBe(1);
  expect(dashboard.groups.find((group) => group.type === "proxy")?.instances[0]?.proxy?.ready).toBeTrue();
  await expect(instances.handlePaperEvent(ids[0]!, { type: "HEARTBEAT", playerIds: [] })).rejects.toThrow("unavailable");
  await expect(database.db.transaction((tx) => transfers.enqueue(tx, { instanceId: ids[0]!, endpoint: "proxy:25700", players: [] }))).rejects.toThrow("unavailable");
  await new CapacityController(database.db, instances, logger).tick();
  expect(creates).toHaveLength(3);
});

test("proxy readiness is idempotent and startup deadlines still fail unready instances", async () => {
  const ids = await startPool();
  const before = registry.length;
  await proxies.heartbeat(ids[0]!, { ready: true, playerCount: 2, acceptingConnections: true });
  await proxies.heartbeat(ids[0]!, { ready: true, playerCount: 2, acceptingConnections: true });
  expect(registry).toHaveLength(before);
  await database.db.update(schema.serverInstances).set({
    lifecycleState: "STARTING", runningAt: null, startupDeadline: new Date(Date.now() - 1_000),
  }).where(eq(schema.serverInstances.id, ids[1]!));
  await proxies.heartbeat(ids[1]!, { ready: false, playerCount: 0, acceptingConnections: false });
  await reconciler().tick();
  const [timedOut] = await database.db.select().from(schema.serverInstances).where(eq(schema.serverInstances.id, ids[1]!));
  expect(timedOut!.lifecycleState).toBe("FAILED");
  expect(timedOut!.failureReason).toBe("STARTUP_TIMEOUT");
  expect((await proxies.list()).some((proxy) => proxy.instanceId === ids[1])).toBeFalse();
});

test("drain waits for acknowledged closed admissions and a fresh empty count", async () => {
  const [id] = await startPool();
  await proxies.heartbeat(id!, { ready: true, playerCount: 0, acceptingConnections: true });
  await instances.beginDrain(id!);
  expect((await proxies.list()).find((proxy) => proxy.instanceId === id)?.acceptingConnections).toBeFalse();
  await tickSessions();
  await reconciler().tick();
  expect(runtime.has(id!)).toBeTrue();
  const control = await proxies.heartbeat(id!, { ready: true, playerCount: 3, acceptingConnections: false });
  expect(control).toMatchObject({ lifecycleState: "DRAINING", acceptingConnections: false });
  await reconciler().tick();
  expect(runtime.has(id!)).toBeTrue();
  await proxies.heartbeat(id!, { ready: true, playerCount: 0, acceptingConnections: false });
  await reconciler().tick();
  expect(runtime.has(id!)).toBeFalse();
});

test("stale heartbeats preserve counts and cannot stop an apparently empty draining proxy", async () => {
  const [id] = await startPool();
  await proxies.heartbeat(id!, { ready: true, playerCount: 4, acceptingConnections: true });
  await database.db.update(schema.proxyHeartbeats).set({ lastSeenAt: new Date(Date.now() - 60_000) }).where(eq(schema.proxyHeartbeats.proxyId, id!));
  expect((await proxies.list()).find((proxy) => proxy.instanceId === id)).toMatchObject({ playerCount: 4, acceptingConnections: false });
  await instances.beginDrain(id!);
  await proxies.heartbeat(id!, { ready: true, playerCount: 0, acceptingConnections: false });
  await database.db.update(schema.proxyHeartbeats).set({ lastSeenAt: new Date(Date.now() - 60_000) }).where(eq(schema.proxyHeartbeats.proxyId, id!));
  await tickSessions();
  await reconciler().tick();
  expect(runtime.has(id!)).toBeTrue();
  await database.db.update(schema.serverInstances).set({ drainDeadline: new Date(Date.now() - 1_000) }).where(eq(schema.serverInstances.id, id!));
  await reconciler().tick();
  expect(runtime.has(id!)).toBeFalse();
  await expect(proxies.heartbeat(id!, { ready: true, playerCount: 0, acceptingConnections: false })).rejects.toThrow("unavailable");
});

test("runtime failure is replaced and maintenance waits for a ready replacement", async () => {
  const ids = await startPool();
  runtime.delete(ids[0]!);
  await reconciler().tick();
  await new CapacityController(database.db, instances, logger).tick();
  const pending = await database.db.select().from(schema.commands).where(eq(schema.commands.state, "PENDING"));
  expect(pending).toHaveLength(1);
  await instances.executeCreate(pending[0]!.instanceId!, pending[0]!.id);
  await proxies.heartbeat(pending[0]!.instanceId!, { ready: true, playerCount: 0, acceptingConnections: false });
  await database.db.update(schema.executionHosts).set({ proxyAddress: "10.0.0.20", proxyPortStart: 25700, proxyPortEnd: 25709 }).where(eq(schema.executionHosts.id, "paper-host"));
  await hosts.requestDrain("proxy-host");
  await new HostMaintenanceController(database.db, hosts, instances, logger).tick();
  const replacements = await database.db.select().from(schema.serverInstances).where(eq(schema.serverInstances.hostId, "paper-host"));
  const replacement = replacements.find((instance) => instance.replacesInstanceId !== null)!;
  expect(replacement.lifecycleState).toBe("CREATING");
  const [source] = await database.db.select().from(schema.serverInstances).where(eq(schema.serverInstances.id, replacement.replacesInstanceId!));
  expect(source!.lifecycleState).toBe("RUNNING");
  const [command] = await database.db.select().from(schema.commands).where(eq(schema.commands.instanceId, replacement.id));
  await instances.executeCreate(replacement.id, command!.id);
  await proxies.heartbeat(replacement.id, { ready: true, playerCount: 0, acceptingConnections: false });
  const [draining] = await database.db.select().from(schema.serverInstances).where(eq(schema.serverInstances.id, replacement.replacesInstanceId!));
  expect(draining!.lifecycleState).toBe("DRAINING");
  expect(registry.some((event) => (event.payload as { groupType?: string }).groupType === "proxy")).toBeFalse();
});
