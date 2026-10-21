import { mkdir, cp, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import Docker from "dockerode";
import { createApp } from "../../src/api/app.ts";
import { createDatabase } from "../../src/db/client.ts";
import { migrateDatabase } from "../../src/db/migrate.ts";
import * as schema from "../../src/db/schema.ts";
import { loadConfig } from "../../src/config.ts";
import { RedisEventBus } from "../../src/events/redis-bus.ts";
import { LocalDockerExecutor } from "../../../agent/src/docker-executor.ts";
import { Logger } from "@endercloud/runtime/logger";
import { DashboardService } from "../../src/modules/dashboard/queries.ts";
import { HostService } from "../../src/modules/hosts/service.ts";
import { HubRouter } from "../../src/modules/routing/hubs.ts";
import { IncidentController } from "../../src/modules/monitoring/incidents.ts";
import { InstanceController } from "../../src/modules/instances/lifecycle.ts";
import { MonitoringService } from "../../src/modules/monitoring/metrics.ts";
import { ProxyService } from "../../src/modules/proxies/service.ts";
import { QueueService } from "../../src/modules/matchmaking/queue.ts";
import { Reconciler } from "../../src/modules/hosts/reconciler.ts";
import { SessionController } from "../../src/modules/sessions/controller.ts";
import { TemplateArchiveService } from "../../src/modules/configuration/archives.ts";
import { TransferService } from "../../src/modules/transfers/service.ts";
import { VariantSelector } from "../../src/modules/instances/variant-selector.ts";
import { eq } from "drizzle-orm";

// Explicit opt-in smoke check. Every Docker resource belongs to this run and is cleaned below.
const velocityJar = process.env.TEST_VELOCITY_JAR;
const paperJar = process.env.TEST_PAPER_JAR;
if (!velocityJar || !paperJar) {
  throw new Error("Set TEST_VELOCITY_JAR and TEST_PAPER_JAR to fixed local server JAR paths");
}
const runId = "proxy-smoke-" + Date.now();
const root = resolve("../runtime", runId);
const pluginRoot = resolve("../plugins");
const logger = new Logger("warn");
const socketPath = process.platform === "win32" ? "//./pipe/docker_engine" : "/var/run/docker.sock";
const docker = new Docker({ socketPath });
let network: Awaited<ReturnType<Docker["createNetwork"]>> | undefined;
let postgres: StartedPostgreSqlContainer | undefined;
let redis: StartedTestContainer | undefined;
let database: ReturnType<typeof createDatabase> | undefined;
let bus: RedisEventBus | undefined;
const hostId = "smoke-host";
const managedIds: string[] = [];
let app: ReturnType<typeof createApp> | undefined;
let executor: LocalDockerExecutor | undefined;

async function waitFor(label: string, predicate: () => Promise<boolean>, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out: " + label);
    await Bun.sleep(1_000);
  }
}

try {
  network = await docker.createNetwork({ Name: runId });
  postgres = await new PostgreSqlContainer("postgres:15-alpine").start();
  redis = await new GenericContainer("redis:8.4.0-alpine").withExposedPorts(6379).start();
  database = createDatabase(postgres.getConnectionUri());
  bus = new RedisEventBus("redis://127.0.0.1:" + redis.getMappedPort(6379), logger);
  await migrateDatabase(postgres.getConnectionUri());
  await bus.connect();
  const db = database.db;
  const hosts = new HostService(db, logger);
  const transfers = new TransferService(db, bus, logger);
  const hubs = new HubRouter(db, transfers);
  const monitoring = new MonitoringService(db, logger);
  // Construct first, then fill in the API port chosen by Bun before starting any instance.
  const executorConfig = {
    hostId, publicUrl: "", dockerSocket: socketPath, dockerNetwork: runId,
    runtimeRoot: join(root, "runtime"), runtimeHostRoot: join(root, "runtime"),
    gameAddress: "host.docker.internal", portStart: 29165, portEnd: 29169,
    proxy: { address: "host.docker.internal", portStart: 29170, portEnd: 29179 },
  };
  executor = new LocalDockerExecutor(executorConfig, logger);
  // Production agents resolve immutable layers through their cache before calling LocalDockerExecutor.
  const createLocalInstance = executor.createInstance.bind(executor);
  executor.createInstance = (spec) => createLocalInstance({
    ...spec,
    templateLayers: spec.templateLayers.map((layer) => ({
      ...layer, templatePath: join(root, "templates", layer.id),
    })),
  });
  const instances = new InstanceController(db, executor, new VariantSelector(db), bus, transfers, hubs, logger, monitoring, hosts);
  const proxies = new ProxyService(db, instances);
  const config = loadConfig({ DATABASE_URL: postgres.getConnectionUri() });
  app = createApp({
    authorize: () => {},
    instances, proxies, hosts, hubs, queues: new QueueService(db),
    dashboard: new DashboardService(db), monitoring,
    templates: new TemplateArchiveService(db), incidents: new IncidentController(db, config, logger),
    logger, isReady: () => true,
  });
  app.listen({ hostname: "0.0.0.0", port: 0 });
  executorConfig.publicUrl = "http://host.docker.internal:" + app.server!.port;
  await db.insert(schema.executionHosts).values({
    id: hostId, controlUrl: executorConfig.publicUrl, gameAddress: executorConfig.gameAddress,
    proxyAddress: executorConfig.proxy.address, proxyPortStart: 29170, proxyPortEnd: 29179,
    allocatableCpu: 8, allocatableMemoryBytes: 8 * 1024 ** 3, healthState: "ONLINE", adminState: "ACTIVE",
    agentVersion: "smoke", lastHeartbeatAt: new Date(),
  });

  for (const [id, type, count] of [["smoke-hub", "hub", 1], ["smoke-proxies", "proxy", 2]] as const) {
    const templatePath = join(root, "templates", id);
    await mkdir(join(templatePath, "plugins"), { recursive: true });
    await cp(type === "proxy" ? velocityJar : paperJar, join(templatePath, "server.jar"));
    const module = type === "proxy" ? "velocity" : "paper";
    const pluginName = type === "proxy" ? "EnderCloudVelocity-0.1.0.jar" : "EnderCloudPaper-0.1.0.jar";
    await cp(join(pluginRoot, module, "build", "libs", pluginName), join(templatePath, "plugins", pluginName));
    const environment: Record<string, string> = type === "proxy" ? {
      TYPE: "CUSTOM", CUSTOM_FAMILY: "velocity", BUNGEE_JAR_FILE: "/server/server.jar", MEMORY: "512m",
      SERVER_PORT: "25565",
      ENDERCLOUD_REDIS_URL: "redis://host.docker.internal:" + redis.getMappedPort(6379),
    } : {
      TYPE: "CUSTOM", CUSTOM_SERVER: "/data/server.jar", EULA: "TRUE", ONLINE_MODE: "FALSE",
      ENFORCE_SECURE_PROFILE: "FALSE", MEMORY: "1536m", VERSION: "26.2", VIEW_DISTANCE: "2", SIMULATION_DISTANCE: "2",
    };
    if (type === "proxy") {
      await writeFile(join(templatePath, "velocity.toml"), [
        'config-version = "2.7"', 'bind = "0.0.0.0:25565"', 'motd = "EnderCloud smoke"',
        'online-mode = false', 'player-info-forwarding-mode = "none"', '[servers]', 'try = []', '[forced-hosts]',
      ].join("\n") + "\n");
    }
    const spec = {
      image: type === "proxy" ? "itzg/mc-proxy:java25" : "itzg/minecraft-server:java25",
      cpu: 2, memoryBytes: type === "proxy" ? 1024 ** 3 : 2 * 1024 ** 3,
      dataDirectory: type === "proxy" ? "/server" : "/data", environment,
    };
    await db.insert(schema.serverGroups).values({
      id, type, minimumInstances: count, maximumInstances: count, minimumWarmInstances: count, maximumWarmInstances: count,
      startupTimeoutMs: 180_000, drainTimeoutMs: 60_000, cancelledDrainTimeoutMs: 10_000,
      shutdownTimeoutMs: 10_000, transferTimeoutMs: 20_000, playerStaleTimeoutMs: 30_000,
      ...(type === "hub" ? { maximumPlayersPerInstance: 100, targetPlayersPerInstance: 70 } : {}),
    });
    await db.insert(schema.templateLayers).values({ id, templatePath, checksum: "smoke", runtimePatch: spec, fileSummary: { fileCount: 2, totalBytes: 0, roots: ["plugins"] } });
    await db.insert(schema.serverVariants).values({ id, revision: 1, checksum: "smoke", runtimeSpec: spec });
    await db.insert(schema.serverVariantLayers).values({ variantId: id, layerId: id, ordinal: 0 });
    await db.insert(schema.serverGroupVariants).values({ groupId: id, variantId: id, selectionWeight: 100 });
    for (let index = 0; index < count; index += 1) {
      const instanceId = await instances.createWarm(id);
      if (!instanceId) throw new Error("Unable to reserve " + id);
      managedIds.push(instanceId);
      const [command] = await db.select().from(schema.commands).where(eq(schema.commands.instanceId, instanceId));
      await instances.executeCreate(instanceId, command!.id);
    }
  }
  await waitFor("two ready proxies and a Paper hub", async () => {
    const failed = await db.select().from(schema.serverInstances).where(eq(schema.serverInstances.lifecycleState, "FAILED"));
    if (failed.length > 0) throw new Error("Live instance failed: " + failed[0]!.failureReason);
    for (const id of managedIds) {
      const observed = await executor!.inspectInstance({ hostId, instanceId: id });
      if (!observed.running) throw new Error("Live container stopped before readiness: " + id);
    }
    const list = await proxies.list();
    return list.length === 2 && list.every((proxy) => proxy.acceptingConnections) && (await instances.listProxyServers()).length === 1;
  });
  const list = await proxies.list();
  console.log("Two live Velocity proxies ready:", list.map((proxy) => proxy.endpoint));
  console.log("Only Paper appears in backend discovery:", (await instances.listProxyServers()).map((server) => server.groupType));
  await instances.beginDrain(list[0]!.instanceId);
  const reconciler = new Reconciler(db, executor, instances, hosts, logger, 300_000);
  const sessions = new SessionController(db, instances, transfers, hubs, logger);
  await waitFor("empty proxy drain confirmed by the real plugin", async () => {
    await sessions.tick();
    await reconciler.tick();
    const [instance] = await db.select().from(schema.serverInstances).where(eq(schema.serverInstances.id, list[0]!.instanceId));
    return instance?.lifecycleState === "STOPPED";
  }, 45_000);
  console.log("Live proxy drain completed; second proxy remains available:", (await proxies.list()).some((proxy) => proxy.acceptingConnections));
} catch (error) {
  for (const id of managedIds) {
    const logs = await executor?.getInstanceLogs({ hostId, instanceId: id }, 80, 12_000).catch(() => "");
    if (logs) console.error(logs);
  }
  throw error;
} finally {
  for (const id of managedIds) await executor?.deleteInstance({ hostId, instanceId: id }).catch(() => {});
  await Promise.allSettled([app?.stop(), bus?.close(), database?.sql.end()]);
  await Promise.allSettled([redis?.stop(), postgres?.stop()]);
  await network?.remove();
  console.log("Temporary Docker resources removed. Smoke templates retained under " + root);
}
