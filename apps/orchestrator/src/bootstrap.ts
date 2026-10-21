import { Logger } from "@endercloud/runtime/logger";
import { mkdir } from "node:fs/promises";
import { createApp } from "./api/app.ts";
import { loadConfig } from "./config.ts";
import { createDatabase } from "./db/client.ts";
import { migrateDatabase } from "./db/migrate.ts";
import { RedisEventBus } from "./events/redis-bus.ts";
import { RegistryOutbox } from "./events/registry-outbox.ts";
import { AgentExecutor } from "./executor/agent-executor.ts";
import { CapacityController } from "./modules/capacity/controller.ts";
import { TemplateArchiveService } from "./modules/configuration/archives.ts";
import { synchronizeConfiguration } from "./modules/configuration/synchronize.ts";
import { DashboardService } from "./modules/dashboard/queries.ts";
import { HostMaintenanceController } from "./modules/hosts/maintenance.ts";
import { Reconciler } from "./modules/hosts/reconciler.ts";
import { HostService } from "./modules/hosts/service.ts";
import { InstanceController } from "./modules/instances/lifecycle.ts";
import { VariantStartController } from "./modules/instances/start-policy.ts";
import { InstanceStartWorker } from "./modules/instances/start-worker.ts";
import { VariantSelector } from "./modules/instances/variant-selector.ts";
import { Matchmaker } from "./modules/matchmaking/matchmaker.ts";
import { QueueService } from "./modules/matchmaking/queue.ts";
import { IncidentController } from "./modules/monitoring/incidents.ts";
import { MonitoringService } from "./modules/monitoring/metrics.ts";
import { ProxyService } from "./modules/proxies/service.ts";
import { HubRouter } from "./modules/routing/hubs.ts";
import { SessionController } from "./modules/sessions/controller.ts";
import { TransferService } from "./modules/transfers/service.ts";
import { createAuth, authHttpHandler } from "./security/auth.ts";
import { loadSecurityConfig } from "./security/config.ts";
import { Credentials } from "./security/credentials.ts";
import { createAuthorizer } from "./security/authorize.ts";
import { Scheduler } from "./scheduler.ts";

import { ResourceScope } from "@endercloud/runtime/lifecycle";
import { acquireLeadership } from "./db/leadership.ts";

export async function startOrchestrator(config = loadConfig(), security = loadSecurityConfig(), signal?: AbortSignal) {
const logger = new Logger(config.logLevel, {
  service: "orchestrator",
  version: "0.1.0",
});
let ready = false;
const resources = new ResourceScope();
function shutdown(reason = "shutdown") {
  ready = false;
  logger.info("orchestrator.shutdown.requested", "Stopping orchestrator", { reason });
  return resources.close();
}
const onAbort = () => { void shutdown(String(signal?.reason ?? "shutdown")).catch(error => logger.error("orchestrator.shutdown.failed", "Cleanup failed", {error})); };
signal?.addEventListener("abort", onAbort, {once: true});
resources.defer("signal listener", () => signal?.removeEventListener("abort", onAbort));
try {
signal?.throwIfAborted();

// Bootstrap persistent dependencies before exposing the HTTP service as ready.
await mkdir(config.groupsRoot, { recursive: true });
await mkdir(config.templatesRoot, { recursive: true });
await migrateDatabase(config.databaseUrl, logger.child({ component: "database-migration" }));

const releaseLeadership = await acquireLeadership(config.databaseUrl, () => {
  process.exitCode = 1;
  void shutdown("DATABASE_LOCK_LOST").catch(error => logger.error("orchestrator.leadership.cleanup_failed", "Leadership cleanup failed", {error}));
});
resources.defer("leadership", releaseLeadership);
const { sql, db } = createDatabase(config.databaseUrl);
resources.defer("database", () => sql.end({timeout: 5}));
await synchronizeConfiguration(
  db,
  config.groupsRoot,
  config.templatesRoot,
  logger.child({ component: "configuration" }),
);
const auth = createAuth(db, security);
const credentials = new Credentials(db, auth, security);
const bus = new RedisEventBus(config.redisUrl, logger.child({ component: "redis-bus" }));
resources.defer("redis", () => bus.close());
await bus.connect();
const outbox = new RegistryOutbox(db, bus);
const hosts = new HostService(db, logger.child({ component: "host-service" }));
const templates = new TemplateArchiveService(db);
const executor = new AgentExecutor(hosts, {
  getControlToken: id => credentials.getControlToken(id),
  operationTimeoutMs: config.agentOperationTimeoutMs,
  probeTimeoutMs: config.agentProbeTimeoutMs,
}, logger.child({ component: "agent-executor" }));
resources.defer("agent requests", () => executor.cancelPending());
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
  config.paperHealthLeaseMs,
  credentials,
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
  config.hostOfflineAfterMs,
  config.paperHealthConfirmationMs,
);
const maintenance = new HostMaintenanceController(db, hosts, instances, logger.child({ component: "host-maintenance" }));
const startWorker = new InstanceStartWorker(
  db,
  instances,
  executor,
  logger.child({ component: "instance-start-worker" }),
  config.instanceStartConcurrency,
);

resources.defer("start worker", () => startWorker.stop(5_000));
const app = createApp({
  authorize: createAuthorizer(db, auth),
  authentication: authHttpHandler(auth),
  proxies: new ProxyService(db, instances),
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
resources.defer("http", () => app.server ? app.stop(true) : undefined);
app.listen({ port: config.port, hostname: "0.0.0.0" });
const server = app.server;
if (!server) throw new Error("Elysia failed to start its HTTP server");

// Agents can report fresh heartbeats while the initial inventory is being reconciled.
// Readiness remains negative until the control plane has converged.
await startWorker.recoverInterrupted();
  await startup.reconcile();
  await reconciler.tick();
  await capacity.tick();
  await transfers.tick();
  await incidents.tick();
signal?.throwIfAborted();
ready = true;

// Each periodic control loop is independent and protects itself from overlapping ticks.
const scheduler = new Scheduler(logger.child({ component: "scheduler" }), incidents);
resources.defer("control loops", async () => { executor.cancelPending(); await scheduler.stop(5_000); });
scheduler.every("registry-outbox", 250, () => outbox.tick());
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

return { app, shutdown };
} catch (error) {
  try { await shutdown("STARTUP_FAILURE"); } catch (cleanupError) { throw new AggregateError([error, cleanupError], "Startup and cleanup failed"); }
  throw error;
}
}
