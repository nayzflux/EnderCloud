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
import { VariantStartController } from "./services/variant-start-controller.ts";
import { InstanceStartWorker } from "./services/instance-start-worker.ts";
import { and, isNull, ne } from "drizzle-orm";
import { serverInstances } from "./db/schema.ts";

const bootstrapLogger = new Logger("error", {
  service: "orchestrator",
  version: "0.1.0",
  component: "bootstrap",
});
process.once("uncaughtException", (error) => {
  bootstrapLogger.error("orchestrator.process.uncaught_exception", "Uncaught orchestrator exception", { error });
  process.exit(1);
});
process.once("unhandledRejection", (error) => {
  bootstrapLogger.error("orchestrator.process.unhandled_rejection", "Unhandled orchestrator rejection", { error });
  process.exit(1);
});

async function main(): Promise<void> {
const config = loadConfig();
const logger = new Logger(config.logLevel, {
  service: "orchestrator",
  version: "0.1.0",
});
let ready = false;

// Bootstrap persistent dependencies before exposing the HTTP service as ready.
await mkdir(config.groupsRoot, { recursive: true });
await mkdir(config.templatesRoot, { recursive: true });
await migrateDatabase(config.databaseUrl, logger.child({ component: "database-migration" }));

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
  logger.child({ component: "configuration" }),
);
const bus = new RedisEventBus(config.redisUrl, logger.child({ component: "redis-bus" }));
await bus.connect();
const hosts = new HostService(db, logger.child({ component: "host-service" }));
const templates = new TemplateArchiveService(db);
const executor = new AgentExecutor(hosts, {
  operationTimeoutMs: config.agentOperationTimeoutMs,
  probeTimeoutMs: config.agentProbeTimeoutMs,
}, logger.child({ component: "agent-executor" }));
const variants = new VariantSelector(db);
const transfers = new TransferService(db, bus, logger.child({ component: "transfer-service" }));
const hubs = new HubRouter(db, transfers);
const monitoring = new MonitoringService(db, logger.child({ component: "monitoring-service" }));
const incidents = new IncidentController(db, config, logger.child({ component: "incident-controller" }));
const startup = new VariantStartController(db, executor, config, logger.child({ component: "variant-start-controller" }));
const instances = new InstanceController(
  db,
  executor,
  variants,
  bus,
  transfers,
  hubs,
  logger.child({ component: "instance-controller" }),
  monitoring,
  hosts,
  startup,
);
const queues = new QueueService(db);
const dashboard = new DashboardService(db, config.instanceStartRetryLimit);
const capacity = new CapacityController(db, instances, logger.child({ component: "capacity-controller" }));
const matchmaker = new Matchmaker(db, transfers, logger.child({ component: "matchmaker" }));
const sessions = new SessionController(db, instances, transfers, hubs, logger.child({ component: "session-controller" }));
const reconciler = new Reconciler(
  db,
  executor,
  instances,
  hosts,
  logger.child({ component: "reconciler" }),
  config.hostOfflineAfterMs,
);
const maintenance = new HostMaintenanceController(db, hosts, instances, logger.child({ component: "host-maintenance" }));
const startWorker = new InstanceStartWorker(
  db,
  instances,
  executor,
  logger.child({ component: "instance-start-worker" }),
  config.instanceStartConcurrency,
);

// Converge database and runtime state once before readiness probes can succeed.
await startWorker.recoverInterrupted();
await startup.reconcile();
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
  startup,
  logger,
  isReady: () => ready,
});
app.listen({ port: config.port, hostname: "0.0.0.0" });
const server = app.server;
if (!server) throw new Error("Elysia failed to start its HTTP server");

// Each periodic control loop is independent and protects itself from overlapping ticks.
const scheduler = new Scheduler(logger.child({ component: "scheduler" }), incidents);
scheduler.every("capacity", config.capacityIntervalMs, () => capacity.tick());
scheduler.every("instance-start-worker", 250, () => startWorker.tick());
scheduler.every("matchmaking", config.matchmakingIntervalMs, () => matchmaker.tick());
scheduler.every("sessions", config.matchmakingIntervalMs, () => sessions.tick());
scheduler.every("transfers", config.matchmakingIntervalMs, () => transfers.tick());
scheduler.every("reconciliation", config.hostReconcileIntervalMs, () => reconciler.tick());
scheduler.every("host-maintenance", config.capacityIntervalMs, () => maintenance.tick());
scheduler.every("incidents", config.incidentReconcileIntervalMs, () => incidents.tick());
scheduler.every("variant-start-policy", config.hostReconcileIntervalMs, () => startup.reconcile());
scheduler.every("monitoring-retention", 60 * 60 * 1_000, () => monitoring.prune());
scheduler.every("incident-retention", 60 * 60 * 1_000, () => incidents.prune());

logger.info("orchestrator.ready", "EnderCloud orchestrator started", {
  url: server.url.toString(),
  openapi: new URL("/openapi", server.url).toString(),
  instanceStartConcurrency: config.instanceStartConcurrency,
  instanceStartRetryLimit: config.instanceStartRetryLimit,
  instanceStartRetryBaseDelayMs: config.instanceStartRetryBaseDelayMs,
  listenPort: config.port,
  groupsDirectory: config.groupsRoot,
  templatesDirectory: config.templatesRoot,
  capacityIntervalMs: config.capacityIntervalMs,
  matchmakingIntervalMs: config.matchmakingIntervalMs,
  reconciliationIntervalMs: config.hostReconcileIntervalMs,
  incidentIntervalMs: config.incidentReconcileIntervalMs,
  executorProbeTimeoutMs: config.agentProbeTimeoutMs,
  executorOperationTimeoutMs: config.agentOperationTimeoutMs,
  logLevel: config.logLevel,
});

async function shutdown(signal: string): Promise<void> {
  if (!ready) return;
  // Fail readiness immediately so no new traffic is routed during teardown.
  ready = false;
  logger.info("orchestrator.shutdown.requested", "Graceful shutdown requested", { signal });
  await scheduler.stop();
  await startWorker.stop();
  await app.stop();
  await bus.close();
  await sql.end({ timeout: 10 });
  logger.info("orchestrator.shutdown.completed", "Graceful shutdown completed", { signal });
}

function requestShutdown(signal: string): void {
  void shutdown(signal).catch((error) => {
    logger.error("orchestrator.shutdown.failed", "Graceful shutdown failed", { signal, error });
    process.exitCode = 1;
  });
}

process.once("SIGINT", () => requestShutdown("SIGINT"));
process.once("SIGTERM", () => requestShutdown("SIGTERM"));
}

try {
  await main();
} catch (error) {
  bootstrapLogger.error("orchestrator.startup.failed", "Orchestrator startup failed", { error });
  process.exitCode = 1;
}
