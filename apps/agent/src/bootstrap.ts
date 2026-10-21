import { bearerAuthorizer } from "@endercloud/runtime/bearer";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { Logger } from "@endercloud/runtime/logger";
import { LocalDockerExecutor } from "./docker-executor.ts";
import { createAgentApp } from "./app.ts";
import { loadAgentConfig } from "./config.ts";
import { TemplateCache } from "./template-cache.ts";

import { ResourceScope } from "@endercloud/runtime/lifecycle";
export async function startAgent(
  config = loadAgentConfig(),
  credentials = {
    controlToken: process.env.AGENT_CONTROL_TOKEN ?? "",
    apiToken: process.env.AGENT_ORCHESTRATOR_TOKEN ?? "",
  },
  signal?: AbortSignal,
) {
  const control = bearerAuthorizer(credentials.controlToken);
  const token = credentials.apiToken;
  if (!token || token.length < 32) throw new Error("AGENT_ORCHESTRATOR_TOKEN is required");
  const logger = new Logger(config.logLevel, {
    service: "agent",
    version: config.agentVersion,
    context: { hostId: config.hostId },
  });
  const resources = new ResourceScope();
  const heartbeatAbort = new AbortController();
  function shutdown() {
    heartbeatAbort.abort();
    return resources.close();
  }
  const onAbort = () => {
    void shutdown().catch((error) =>
      logger.error("agent.shutdown.failed", "Agent cleanup failed", { error }),
    );
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  resources.defer("signal listener", () => signal?.removeEventListener("abort", onAbort));
  try {
    signal?.throwIfAborted();
    await Promise.all([
      mkdir(config.runtimeRoot, { recursive: true }),
      mkdir(config.templateCacheRoot, { recursive: true }),
    ]);
    const executor = new LocalDockerExecutor(
      { ...config, journalPath: join(config.runtimeRoot, "agent-journal.sqlite") },
      logger.child({ component: "docker-executor" }),
    );
    resources.defer("operation journal", () => executor.close());
    const templates = new TemplateCache(
      config.templateCacheRoot,
      config.orchestratorUrl,
      logger.child({ component: "template-cache" }),
      {
        token,
        timeoutMs: config.templateDownloadTimeoutMs,
        idleTimeoutMs: config.templateIdleTimeoutMs,
        maxExpandedBytes: config.templateMaxExpandedBytes,
        maxEntries: config.templateMaxEntries,
        concurrency: config.templateDownloadConcurrency,
      },
    );
    resources.defer("templates", () => templates.close());
    await templates.initialize();
    const app = createAgentApp(
      config,
      executor,
      templates,
      logger.child({ component: "http-api" }),
      control,
    );
    resources.defer("http", () => (app.server ? app.stop(true) : undefined));
    app.listen({ port: config.port, hostname: "0.0.0.0" });

    let heartbeatRunning = false;
    let heartbeatFailures = 0;
    let heartbeatFailureStartedAt: number | null = null;
    async function heartbeat(): Promise<void> {
      if (heartbeatRunning || heartbeatAbort.signal.aborted) return;
      heartbeatRunning = true;
      const requestId = crypto.randomUUID();
      try {
        const response = await fetch(
          new URL(
            `/api/v1/hosts/${encodeURIComponent(config.hostId)}/heartbeat`,
            config.orchestratorUrl,
          ),
          {
            method: "PUT",
            headers: {
              "content-type": "application/json",
              "x-request-id": requestId,
              authorization: `Bearer ${token}`,
            },
            signal: AbortSignal.any([
              heartbeatAbort.signal,
              AbortSignal.timeout(Math.min(3_000, config.heartbeatIntervalMs)),
            ]),
            body: JSON.stringify({
              controlUrl: config.controlUrl,
              gameAddress: config.gameAddress,
              ...(config.proxy ? { proxy: config.proxy } : {}),
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
            downtimeMs:
              heartbeatFailureStartedAt === null ? 0 : Date.now() - heartbeatFailureStartedAt,
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
          logger.warn("agent.heartbeat.lost", "Agent heartbeat failed", {
            error,
            failureCount: 1,
            requestId,
          });
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
    signal?.throwIfAborted();
    const heartbeatTimer = setInterval(() => void heartbeat(), config.heartbeatIntervalMs);
    resources.defer("heartbeat", () => clearInterval(heartbeatTimer));
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

    return { app, shutdown };
  } catch (error) {
    try {
      await shutdown();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Agent startup and cleanup failed");
    }
    throw error;
  }
}
