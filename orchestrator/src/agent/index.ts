import { mkdir } from "node:fs/promises";
import { Logger } from "../logger.ts";
import { LocalDockerExecutor } from "../executor/local-docker.ts";
import { createAgentApp } from "./app.ts";
import { loadAgentConfig } from "./config.ts";
import { TemplateCache } from "./template-cache.ts";

const bootstrapLogger = new Logger("error", {
  service: "agent",
  version: "unknown",
  component: "bootstrap",
});
process.once("uncaughtException", (error) => {
  bootstrapLogger.error("agent.process.uncaught_exception", "Uncaught agent exception", { error });
  process.exit(1);
});
process.once("unhandledRejection", (error) => {
  bootstrapLogger.error("agent.process.unhandled_rejection", "Unhandled agent rejection", { error });
  process.exit(1);
});

async function main(): Promise<void> {
const config = loadAgentConfig();
const logger = new Logger(config.logLevel, {
  service: "agent",
  version: config.agentVersion,
  context: { hostId: config.hostId },
});
await Promise.all([
  mkdir(config.runtimeRoot, { recursive: true }),
  mkdir(config.templateCacheRoot, { recursive: true }),
]);
const executor = new LocalDockerExecutor(config, logger.child({ component: "docker-executor" }));
const templates = new TemplateCache(
  config.templateCacheRoot,
  config.orchestratorUrl,
  logger.child({ component: "template-cache" }),
);
const app = createAgentApp(config, executor, templates, logger.child({ component: "http-api" }));
app.listen({ port: config.port, hostname: "0.0.0.0" });

let heartbeatRunning = false;
let heartbeatFailures = 0;
let heartbeatFailureStartedAt: number | null = null;
async function heartbeat(): Promise<void> {
  if (heartbeatRunning) return;
  heartbeatRunning = true;
  const requestId = crypto.randomUUID();
  try {
    const response = await fetch(
      new URL(`/api/v1/hosts/${encodeURIComponent(config.hostId)}/heartbeat`, config.orchestratorUrl),
      {
        method: "PUT",
        headers: { "content-type": "application/json", "x-request-id": requestId },
        signal: AbortSignal.timeout(Math.min(3_000, config.heartbeatIntervalMs)),
        body: JSON.stringify({
          controlUrl: config.controlUrl,
          gameAddress: config.gameAddress,
          allocatableCpu: config.allocatableCpu,
          allocatableMemoryBytes: config.allocatableMemoryBytes,
          agentVersion: config.agentVersion,
        }),
      },
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (heartbeatFailures > 0) {
      logger.info("agent.heartbeat.recovered", "Agent heartbeat recovered", {
        failureCount: heartbeatFailures,
        downtimeMs: heartbeatFailureStartedAt === null ? 0 : Date.now() - heartbeatFailureStartedAt,
        requestId,
      });
    } else {
      logger.debug("agent.heartbeat.completed", "Agent heartbeat completed", { requestId });
    }
    heartbeatFailures = 0;
    heartbeatFailureStartedAt = null;
  } catch (error) {
    heartbeatFailures += 1;
    heartbeatFailureStartedAt ??= Date.now();
    if (heartbeatFailures === 1) {
      logger.warn("agent.heartbeat.lost", "Agent heartbeat failed", { error, failureCount: 1, requestId });
    } else {
      logger.debug("agent.heartbeat.failed", "Agent heartbeat still failing", {
        error,
        failureCount: heartbeatFailures,
        requestId,
      });
    }
  } finally {
    heartbeatRunning = false;
  }
}

await heartbeat();
const heartbeatTimer = setInterval(() => void heartbeat(), config.heartbeatIntervalMs);
logger.info("agent.ready", "EnderCloud execution agent started", {
  hostId: config.hostId,
  port: config.port,
  controlUrl: config.controlUrl,
  orchestratorUrl: config.orchestratorUrl,
  gameAddress: config.gameAddress,
  allocatableCpu: config.allocatableCpu,
  allocatableMemoryBytes: config.allocatableMemoryBytes,
  heartbeatIntervalMs: config.heartbeatIntervalMs,
  dockerSocket: config.dockerSocket,
  dockerNetwork: config.dockerNetwork,
  runtimeDirectory: config.runtimeRoot,
  runtimeHostDirectory: config.runtimeHostRoot,
  templateCacheDirectory: config.templateCacheRoot,
  gamePortStart: config.portStart,
  gamePortEnd: config.portEnd,
  logLevel: config.logLevel,
});

async function shutdown(signal: string): Promise<void> {
  clearInterval(heartbeatTimer);
  logger.info("agent.shutdown.requested", "Agent shutdown requested", { signal });
  await app.stop();
  logger.info("agent.shutdown.completed", "Agent shutdown completed", { signal });
}

function requestShutdown(signal: string): void {
  void shutdown(signal).catch((error) => {
    logger.error("agent.shutdown.failed", "Agent shutdown failed", { signal, error });
    process.exitCode = 1;
  });
}

process.once("SIGINT", () => requestShutdown("SIGINT"));
process.once("SIGTERM", () => requestShutdown("SIGTERM"));
}

try {
  await main();
} catch (error) {
  bootstrapLogger.error("agent.startup.failed", "Agent startup failed", { error });
  process.exitCode = 1;
}
