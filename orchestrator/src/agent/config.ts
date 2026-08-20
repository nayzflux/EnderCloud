import { resolve } from "node:path";
import type { LocalDockerConfig } from "../executor/local-docker.ts";

function integer(name: string, fallback?: number, minimum = 1): number {
  const raw = process.env[name];
  if (raw === undefined && fallback === undefined) throw new Error(`${name} is required`);
  const value = Number.parseInt(raw ?? String(fallback), 10);
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}`);
  }
  return value;
}

function positive(name: string): number {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
  return value;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function url(name: string): string {
  const value = required(name);
  try {
    return new URL(value).toString();
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
}

export interface AgentConfig extends LocalDockerConfig {
  readonly port: number;
  readonly controlUrl: string;
  readonly orchestratorUrl: string;
  readonly templateCacheRoot: string;
  readonly allocatableCpu: number;
  readonly allocatableMemoryBytes: number;
  readonly heartbeatIntervalMs: number;
  readonly agentVersion: string;
  readonly logLevel: string;
}

export function loadAgentConfig(): AgentConfig {
  const portStart = integer("AGENT_GAME_PORT_START", 25_565, 1);
  const portEnd = integer("AGENT_GAME_PORT_END", 25_664, portStart);
  const runtimeRoot = resolve(process.env.RUNTIME_ROOT ?? "/data/runtime");
  const orchestratorUrl = url("ORCHESTRATOR_URL");
  const hostId = required("AGENT_ID");
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(hostId)) {
    throw new Error("AGENT_ID must be a lowercase id containing only letters, digits and dashes");
  }
  return {
    hostId,
    port: integer("AGENT_PORT", 8_090, 1),
    controlUrl: url("AGENT_PUBLIC_URL"),
    orchestratorUrl,
    publicUrl: orchestratorUrl,
    gameAddress: required("AGENT_GAME_ADDRESS"),
    allocatableCpu: positive("AGENT_CPU"),
    allocatableMemoryBytes: integer("AGENT_MEMORY_BYTES"),
    heartbeatIntervalMs: integer("AGENT_HEARTBEAT_INTERVAL_MS", 5_000, 1_000),
    agentVersion: process.env.AGENT_VERSION ?? "0.1.0",
    dockerSocket:
      process.env.DOCKER_SOCKET ??
      (process.platform === "win32" ? "//./pipe/docker_engine" : "/var/run/docker.sock"),
    dockerNetwork: process.env.DOCKER_NETWORK ?? "endercloud",
    runtimeRoot,
    runtimeHostRoot: required("RUNTIME_HOST_ROOT"),
    templateCacheRoot: resolve(process.env.TEMPLATE_CACHE_ROOT ?? "/data/template-cache"),
    portStart,
    portEnd,
    logLevel: process.env.LOG_LEVEL ?? "info",
  };
}
