import { mkdir } from "node:fs/promises";
import { createApp } from "./api/app.ts";
import { loadConfig } from "./config.ts";
import { synchronizeConfiguration } from "./configuration/sync.ts";
import { createDatabase } from "./db/client.ts";
import { migrateDatabase } from "./db/migrate.ts";
import { RedisEventBus } from "./events/redis-bus.ts";
import { AgentExecutor } from "./executor/agent-executor.ts";
import { Logger } from "./logger.ts";
import { Scheduler } from "./scheduler.ts";
import { CapacityController } from "./services/capacity-controller.ts";
import { DashboardService } from "./services/dashboard-service.ts";
import { InstanceController } from "./services/instance-controller.ts";
import { Matchmaker } from "./services/matchmaker.ts";
import { QueueService } from "./services/queue-service.ts";
import { Reconciler } from "./services/reconciler.ts";
import { SessionController } from "./services/session-controller.ts";
import { TransferService } from "./services/transfer-service.ts";
import { VariantSelector } from "./services/variant-selector.ts";
import { HubRouter } from "./services/hub-router.ts";
import { MonitoringService } from "./services/monitoring-service.ts";
import { HostService } from "./services/host-service.ts";
import { TemplateArchiveService } from "./services/template-archive-service.ts";
import { HostMaintenanceController } from "./services/host-maintenance-controller.ts";
import { IncidentController } from "./services/incident-controller.ts";
import { and, isNull, ne } from "drizzle-orm";
import { serverInstances } from "./db/schema.ts";

const config = loadConfig();
const logger = new Logger(config.logLevel);
let ready = false;

if (config.legacyTransferTimeoutConfigured) {
  logger.warn("TRANSFER_TIMEOUT_MS is deprecated; configure timeouts.transfer per group");
}
if (config.legacyCancelledDrainTimeoutConfigured) {
  logger.warn(
    "CANCELLED_DRAIN_TIMEOUT_MS is deprecated; configure timeouts.cancelled_drain per group",
  );
}

// Bootstrap persistent dependencies before exposing the HTTP service as ready.
await mkdir(config.groupsRoot, { recursive: true });
await mkdir(config.templatesRoot, { recursive: true });
await migrateDatabase(config.databaseUrl);

const { sql, db } = createDatabase(config.databaseUrl);
const unassignedActive = await db.select({ id: serverInstances.id })
  .from(serverInstances)
  .where(and(
    ne(serverInstances.lifecycleState, "STOPPED"),
    isNull(serverInstances.hostId),
  ))
  .limit(1);
if (unassignedActive[0]) {
  throw new Error(
    `Active legacy instance ${unassignedActive[0].id} has no host_id; stop all instances before migration`,
  );
}
await synchronizeConfiguration(
  db,
  config.groupsRoot,
  config.templatesRoot,
  logger,
  {
    transferMs: config.legacyTransferTimeoutMs,
    cancelledDrainMs: config.legacyCancelledDrainTimeoutMs,
    playerStaleMs: 30_000,
  },
);
const bus = new RedisEventBus(config.redisUrl, logger);
await bus.connect();
const hosts = new HostService(db);
const templates = new TemplateArchiveService(db);
const executor = new AgentExecutor(hosts, {
  operationTimeoutMs: config.agentOperationTimeoutMs,
  probeTimeoutMs: config.agentProbeTimeoutMs,
});
const variants = new VariantSelector(db);
const transfers = new TransferService(db, bus, logger);
const hubs = new HubRouter(db, transfers);
const monitoring = new MonitoringService(db, logger);
const incidents = new IncidentController(db, config, logger);
const instances = new InstanceController(
  db,
  executor,
  variants,
  bus,
  transfers,
  hubs,
  logger,
  monitoring,
  hosts,
);
const queues = new QueueService(db);
const dashboard = new DashboardService(db);
const capacity = new CapacityController(db, instances, logger);
const matchmaker = new Matchmaker(db, transfers, logger);
const sessions = new SessionController(db, instances, transfers, hubs, config, logger);
const reconciler = new Reconciler(
  db,
  executor,
  instances,
  hosts,
  logger,
  config.hostOfflineAfterMs,
);
const maintenance = new HostMaintenanceController(db, hosts, instances, logger);

// Converge database and runtime state once before readiness probes can succeed.
await reconciler.tick();
await capacity.tick();
await transfers.tick();
await incidents.tick();
ready = true;

const app = createApp({
  queues,
  instances,
  hubs,
  dashboard,
  monitoring,
  hosts,
  templates,
  incidents,
  logger,
  isReady: () => ready,
});
app.listen({ port: config.port, hostname: "0.0.0.0" });
const server = app.server;
if (!server) throw new Error("Elysia failed to start its HTTP server");

// Each periodic control loop is independent and protects itself from overlapping ticks.
const scheduler = new Scheduler(logger, incidents);
scheduler.every("capacity", config.capacityIntervalMs, () => capacity.tick());
scheduler.every("matchmaking", config.matchmakingIntervalMs, () => matchmaker.tick());
scheduler.every("sessions", config.matchmakingIntervalMs, () => sessions.tick());
scheduler.every("transfers", config.matchmakingIntervalMs, () => transfers.tick());
scheduler.every("reconciliation", config.hostReconcileIntervalMs, () => reconciler.tick());
scheduler.every("host-maintenance", config.capacityIntervalMs, () => maintenance.tick());
scheduler.every("incidents", config.incidentReconcileIntervalMs, () => incidents.tick());
scheduler.every("monitoring-retention", 60 * 60 * 1_000, () => monitoring.prune());
scheduler.every("incident-retention", 60 * 60 * 1_000, () => incidents.prune());

logger.info("EnderCloud orchestrator started", {
  url: server.url.toString(),
  openapi: new URL("/openapi", server.url).toString(),
});

async function shutdown(signal: string): Promise<void> {
  if (!ready) return;
  // Fail readiness immediately so no new traffic is routed during teardown.
  ready = false;
  logger.info("Graceful shutdown requested", { signal });
  scheduler.stop();
  await app.stop();
  await bus.close();
  await sql.end({ timeout: 10 });
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
