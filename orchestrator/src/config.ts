import { resolve } from "node:path";

function integer(name: string, fallback: number, minimum = 1): number {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}`);
  }
  return value;
}

function requiredUrl(name: string, fallback: string): string {
  const value = process.env[name] ?? fallback;
  try {
    new URL(value);
    return value;
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
}

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
  /** Deprecated group-policy fallbacks kept for one compatibility window. */
  readonly legacyTransferTimeoutMs: number;
  readonly legacyCancelledDrainTimeoutMs: number;
  readonly legacyTransferTimeoutConfigured: boolean;
  readonly legacyCancelledDrainTimeoutConfigured: boolean;
  readonly maxInstanceRetries: number;
  readonly logLevel: string;
}

// Load and validate all runtime settings from environment variables.
export function loadConfig(): AppConfig {
  return {
    databaseUrl: requiredUrl(
      "DATABASE_URL",
      "postgres://endercloud:endercloud@localhost:5432/endercloud",
    ),
    redisUrl: requiredUrl("REDIS_URL", "redis://localhost:6379"),
    port: integer("ORCHESTRATOR_PORT", 8080),
    groupsRoot: resolve(process.env.GROUPS_ROOT ?? "../groups"),
    templatesRoot: resolve(process.env.TEMPLATES_ROOT ?? "../templates"),
    capacityIntervalMs: integer("CAPACITY_INTERVAL_MS", 5_000, 100),
    matchmakingIntervalMs: integer("MATCHMAKING_INTERVAL_MS", 1_000, 100),
    hostReconcileIntervalMs: integer("HOST_RECONCILE_INTERVAL_MS", 5_000, 1_000),
    hostOfflineAfterMs: integer("HOST_OFFLINE_AFTER_MS", 30_000, 5_000),
    agentProbeTimeoutMs: integer("AGENT_PROBE_TIMEOUT_MS", 3_000, 100),
    agentOperationTimeoutMs: integer("AGENT_OPERATION_TIMEOUT_MS", 600_000, 1_000),
    incidentReconcileIntervalMs: integer("INCIDENT_RECONCILE_INTERVAL_MS", 5_000, 1_000),
    incidentBlockedAfterMs: integer("INCIDENT_BLOCKED_AFTER_MS", 30_000, 1_000),
    incidentFailureThreshold: integer("INCIDENT_FAILURE_THRESHOLD", 3, 1),
    incidentFailureWindowMs: integer("INCIDENT_FAILURE_WINDOW_MS", 900_000, 1_000),
    incidentHostRecoveryAfterMs: integer("INCIDENT_HOST_RECOVERY_AFTER_MS", 60_000, 1_000),
    incidentHistoryRetentionMs: integer(
      "INCIDENT_HISTORY_RETENTION_MS",
      7_776_000_000,
      60_000,
    ),
    legacyTransferTimeoutMs: integer("TRANSFER_TIMEOUT_MS", 20_000, 1),
    legacyCancelledDrainTimeoutMs: integer("CANCELLED_DRAIN_TIMEOUT_MS", 10_000, 1),
    legacyTransferTimeoutConfigured: process.env.TRANSFER_TIMEOUT_MS !== undefined,
    legacyCancelledDrainTimeoutConfigured:
      process.env.CANCELLED_DRAIN_TIMEOUT_MS !== undefined,
    maxInstanceRetries: integer("MAX_INSTANCE_RETRIES", 2, 0),
    logLevel: process.env.LOG_LEVEL ?? "info",
  };
}
