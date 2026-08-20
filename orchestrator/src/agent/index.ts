import { mkdir } from "node:fs/promises";
import { Logger } from "../logger.ts";
import { LocalDockerExecutor } from "../executor/local-docker.ts";
import { createAgentApp } from "./app.ts";
import { loadAgentConfig } from "./config.ts";
import { TemplateCache } from "./template-cache.ts";

const config = loadAgentConfig();
const logger = new Logger(config.logLevel);
await Promise.all([
  mkdir(config.runtimeRoot, { recursive: true }),
  mkdir(config.templateCacheRoot, { recursive: true }),
]);
const executor = new LocalDockerExecutor(config, logger);
const templates = new TemplateCache(config.templateCacheRoot, config.orchestratorUrl);
const app = createAgentApp(config, executor, templates);
app.listen({ port: config.port, hostname: "0.0.0.0" });

let heartbeatRunning = false;
async function heartbeat(): Promise<void> {
  if (heartbeatRunning) return;
  heartbeatRunning = true;
  try {
    const response = await fetch(
      new URL(`/api/v1/hosts/${encodeURIComponent(config.hostId)}/heartbeat`, config.orchestratorUrl),
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
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
  } catch (error) {
    logger.error("Agent heartbeat failed", { error: String(error) });
  } finally {
    heartbeatRunning = false;
  }
}

await heartbeat();
const heartbeatTimer = setInterval(() => void heartbeat(), config.heartbeatIntervalMs);
logger.info("EnderCloud execution agent started", {
  hostId: config.hostId,
  port: config.port,
  gameAddress: config.gameAddress,
});

async function shutdown(signal: string): Promise<void> {
  clearInterval(heartbeatTimer);
  logger.info("Agent shutdown requested", { signal });
  await app.stop();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
