import { resolve } from "node:path";
import type { LocalDockerConfig } from "../executor/local-docker.ts";
import {
  duration,
  integer,
  logLevel,
  optionalString,
  positiveNumber,
  rejectDeprecatedEnvironment,
  requiredString,
  url,
  type Environment,
} from "../env.ts";
import type { LogLevel } from "../logger.ts";

const deprecated = {
  AGENT_PORT: "AGENT_LISTEN_PORT",
  AGENT_PUBLIC_URL: "AGENT_ADVERTISED_CONTROL_URL",
  AGENT_GAME_ADDRESS: "AGENT_ADVERTISED_GAME_ADDRESS",
  AGENT_CPU: "AGENT_ALLOCATABLE_CPU",
  AGENT_MEMORY_BYTES: "AGENT_ALLOCATABLE_MEMORY_BYTES",
  AGENT_HEARTBEAT_INTERVAL_MS: "AGENT_HEARTBEAT_INTERVAL",
  DOCKER_SOCKET: "AGENT_DOCKER_SOCKET",
  DOCKER_NETWORK: "AGENT_DOCKER_NETWORK",
  RUNTIME_ROOT: "AGENT_RUNTIME_DIRECTORY",
  RUNTIME_HOST_ROOT: "AGENT_RUNTIME_HOST_DIRECTORY",
  TEMPLATE_CACHE_ROOT: "AGENT_TEMPLATE_CACHE_DIRECTORY",
  LOG_LEVEL: "AGENT_LOG_LEVEL",
} as const;

export interface AgentConfig extends LocalDockerConfig {
  readonly port: number;
  readonly controlUrl: string;
  readonly orchestratorUrl: string;
  readonly templateCacheRoot: string;
  readonly allocatableCpu: number;
  readonly allocatableMemoryBytes: number;
  readonly heartbeatIntervalMs: number;
  readonly agentVersion: string;
  readonly logLevel: LogLevel;
}

export function loadAgentConfig(environment: Environment = process.env): AgentConfig {
  rejectDeprecatedEnvironment(environment, deprecated);
  const portStart = integer(environment, "AGENT_GAME_PORT_START", 25_565, 1, 65_535);
  const portEnd = integer(environment, "AGENT_GAME_PORT_END", 25_664, portStart, 65_535);
  const runtimeRoot = resolve(optionalString(environment, "AGENT_RUNTIME_DIRECTORY", "/data/runtime"));
  const orchestratorUrl = url(environment, "ORCHESTRATOR_URL", undefined, ["http:", "https:"]);
  const hostId = requiredString(environment, "AGENT_ID");
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(hostId)) {
    throw new Error("AGENT_ID must be a lowercase id containing only letters, digits and dashes");
  }
  return {
    hostId,
    port: integer(environment, "AGENT_LISTEN_PORT", 8_090, 1, 65_535),
    controlUrl: url(environment, "AGENT_ADVERTISED_CONTROL_URL", undefined, ["http:", "https:"]),
    orchestratorUrl,
    publicUrl: orchestratorUrl,
    gameAddress: requiredString(environment, "AGENT_ADVERTISED_GAME_ADDRESS"),
    allocatableCpu: positiveNumber(environment, "AGENT_ALLOCATABLE_CPU"),
    allocatableMemoryBytes: integer(environment, "AGENT_ALLOCATABLE_MEMORY_BYTES"),
    heartbeatIntervalMs: duration(environment, "AGENT_HEARTBEAT_INTERVAL", "5s", 1_000),
    agentVersion: optionalString(environment, "AGENT_VERSION", "0.1.0"),
    dockerSocket: optionalString(environment, "AGENT_DOCKER_SOCKET", process.platform === "win32" ? "//./pipe/docker_engine" : "/var/run/docker.sock"),
    dockerNetwork: optionalString(environment, "AGENT_DOCKER_NETWORK", "endercloud"),
    runtimeRoot,
    runtimeHostRoot: requiredString(environment, "AGENT_RUNTIME_HOST_DIRECTORY"),
    templateCacheRoot: resolve(optionalString(environment, "AGENT_TEMPLATE_CACHE_DIRECTORY", "/data/template-cache")),
    portStart,
    portEnd,
    logLevel: logLevel(environment, "AGENT_LOG_LEVEL"),
  };
}
