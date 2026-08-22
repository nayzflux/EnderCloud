import { resolve } from "node:path";
import {
  duration,
  integer,
  logLevel,
  optionalString,
  rejectDeprecatedEnvironment,
  url,
  type Environment,
} from "./env.ts";
import type { LogLevel } from "./logger.ts";

const deprecated = {
  ORCHESTRATOR_PORT: "ORCHESTRATOR_LISTEN_PORT",
  GROUPS_ROOT: "ORCHESTRATOR_GROUPS_DIRECTORY",
  TEMPLATES_ROOT: "ORCHESTRATOR_TEMPLATES_DIRECTORY",
  CAPACITY_INTERVAL_MS: "SCHEDULER_CAPACITY_INTERVAL",
  MATCHMAKING_INTERVAL_MS: "SCHEDULER_MATCHMAKING_INTERVAL",
  HOST_RECONCILE_INTERVAL_MS: "SCHEDULER_RECONCILIATION_INTERVAL",
  RECONCILE_INTERVAL_MS: "SCHEDULER_RECONCILIATION_INTERVAL",
  HOST_OFFLINE_AFTER_MS: "HOST_OFFLINE_TIMEOUT",
  AGENT_PROBE_TIMEOUT_MS: "EXECUTOR_PROBE_TIMEOUT",
  AGENT_OPERATION_TIMEOUT_MS: "EXECUTOR_OPERATION_TIMEOUT",
  INCIDENT_RECONCILE_INTERVAL_MS: "SCHEDULER_INCIDENT_INTERVAL",
  INCIDENT_BLOCKED_AFTER_MS: "INCIDENT_BLOCKED_AFTER",
  INCIDENT_FAILURE_WINDOW_MS: "INCIDENT_FAILURE_WINDOW",
  INCIDENT_HOST_RECOVERY_AFTER_MS: "INCIDENT_HOST_RECOVERY_AFTER",
  INCIDENT_HISTORY_RETENTION_MS: "INCIDENT_HISTORY_RETENTION",
  TRANSFER_TIMEOUT_MS: "the group timeouts.transfer setting",
  CANCELLED_DRAIN_TIMEOUT_MS: "the group timeouts.cancelled_drain setting",
  MAX_INSTANCE_RETRIES: "INSTANCE_START_RETRY_LIMIT",
  LOG_LEVEL: "ORCHESTRATOR_LOG_LEVEL",
} as const;

export interface AppConfig {
  readonly databaseUrl: string;
  readonly redisUrl: string;
  readonly port: number;
  readonly groupsRoot: string;
  readonly templatesRoot: string;
  readonly capacityIntervalMs: number;
  readonly matchmakingIntervalMs: number;
  readonly hostReconcileIntervalMs: number;
  readonly hostOfflineAfterMs: number;
  readonly agentProbeTimeoutMs: number;
  readonly agentOperationTimeoutMs: number;
  readonly incidentReconcileIntervalMs: number;
  readonly incidentBlockedAfterMs: number;
  readonly incidentFailureThreshold: number;
  readonly incidentFailureWindowMs: number;
  readonly incidentHostRecoveryAfterMs: number;
  readonly incidentHistoryRetentionMs: number;
  readonly instanceStartConcurrency: number;
  readonly instanceStartRetryLimit: number;
  readonly instanceStartRetryBaseDelayMs: number;
  readonly logLevel: LogLevel;
}

export function loadConfig(environment: Environment = process.env): AppConfig {
  rejectDeprecatedEnvironment(environment, deprecated);
  const databaseUrl = url(
    environment,
    "DATABASE_URL",
    undefined,
    ["postgres:", "postgresql:"],
  );
  if (!new URL(databaseUrl).password) {
    throw new Error("DATABASE_URL must contain an explicit PostgreSQL password");
  }
  return {
    databaseUrl,
    redisUrl: url(environment, "REDIS_URL", "redis://localhost:6379", ["redis:", "rediss:"]),
    port: integer(environment, "ORCHESTRATOR_LISTEN_PORT", 8_080, 1, 65_535),
    groupsRoot: resolve(optionalString(environment, "ORCHESTRATOR_GROUPS_DIRECTORY", "../groups")),
    templatesRoot: resolve(optionalString(environment, "ORCHESTRATOR_TEMPLATES_DIRECTORY", "../templates")),
    capacityIntervalMs: duration(environment, "SCHEDULER_CAPACITY_INTERVAL", "5s", 100),
    matchmakingIntervalMs: duration(environment, "SCHEDULER_MATCHMAKING_INTERVAL", "1s", 100),
    hostReconcileIntervalMs: duration(environment, "SCHEDULER_RECONCILIATION_INTERVAL", "5s", 1_000),
    hostOfflineAfterMs: duration(environment, "HOST_OFFLINE_TIMEOUT", "30s", 5_000),
    agentProbeTimeoutMs: duration(environment, "EXECUTOR_PROBE_TIMEOUT", "3s", 100),
    agentOperationTimeoutMs: duration(environment, "EXECUTOR_OPERATION_TIMEOUT", "10m", 1_000),
    incidentReconcileIntervalMs: duration(environment, "SCHEDULER_INCIDENT_INTERVAL", "5s", 1_000),
    incidentBlockedAfterMs: duration(environment, "INCIDENT_BLOCKED_AFTER", "30s", 1_000),
    incidentFailureThreshold: integer(environment, "INCIDENT_FAILURE_THRESHOLD", 3),
    incidentFailureWindowMs: duration(environment, "INCIDENT_FAILURE_WINDOW", "15m", 1_000),
    incidentHostRecoveryAfterMs: duration(environment, "INCIDENT_HOST_RECOVERY_AFTER", "1m", 1_000),
    incidentHistoryRetentionMs: duration(environment, "INCIDENT_HISTORY_RETENTION", "90d", 60_000),
    instanceStartConcurrency: integer(environment, "INSTANCE_START_CONCURRENCY", 4, 1, 64),
    instanceStartRetryLimit: integer(environment, "INSTANCE_START_RETRY_LIMIT", 5, 0, 20),
    instanceStartRetryBaseDelayMs: duration(environment, "INSTANCE_START_RETRY_BASE_DELAY", "1s"),
    logLevel: logLevel(environment, "ORCHESTRATOR_LOG_LEVEL"),
  };
}
