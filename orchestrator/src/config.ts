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
  readonly publicUrl: string;
  readonly dockerSocket: string;
  readonly dockerNetwork: string;
  readonly groupsRoot: string;
  readonly templatesRoot: string;
  readonly runtimeRoot: string;
  readonly runtimeHostRoot: string;
  readonly capacityIntervalMs: number;
  readonly matchmakingIntervalMs: number;
  readonly reconcileIntervalMs: number;
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
  const runtimeRoot = resolve(process.env.RUNTIME_ROOT ?? "../runtime");
  return {
    databaseUrl: requiredUrl(
      "DATABASE_URL",
      "postgres://endercloud:endercloud@localhost:5432/endercloud",
    ),
    redisUrl: requiredUrl("REDIS_URL", "redis://localhost:6379"),
    port: integer("ORCHESTRATOR_PORT", 8080),
    publicUrl: requiredUrl("ORCHESTRATOR_PUBLIC_URL", "http://localhost:8080"),
    dockerSocket:
      process.env.DOCKER_SOCKET ??
      (process.platform === "win32" ? "//./pipe/docker_engine" : "/var/run/docker.sock"),
    dockerNetwork: process.env.DOCKER_NETWORK ?? "endercloud",
    groupsRoot: resolve(process.env.GROUPS_ROOT ?? "../groups"),
    templatesRoot: resolve(process.env.TEMPLATES_ROOT ?? "../templates"),
    runtimeRoot,
    runtimeHostRoot: process.env.RUNTIME_HOST_ROOT ?? runtimeRoot,
    capacityIntervalMs: integer("CAPACITY_INTERVAL_MS", 5_000, 100),
    matchmakingIntervalMs: integer("MATCHMAKING_INTERVAL_MS", 1_000, 100),
    reconcileIntervalMs: integer("RECONCILE_INTERVAL_MS", 15_000, 1_000),
    legacyTransferTimeoutMs: integer("TRANSFER_TIMEOUT_MS", 20_000, 1),
    legacyCancelledDrainTimeoutMs: integer("CANCELLED_DRAIN_TIMEOUT_MS", 10_000, 1),
    legacyTransferTimeoutConfigured: process.env.TRANSFER_TIMEOUT_MS !== undefined,
    legacyCancelledDrainTimeoutConfigured:
      process.env.CANCELLED_DRAIN_TIMEOUT_MS !== undefined,
    maxInstanceRetries: integer("MAX_INSTANCE_RETRIES", 2, 0),
    logLevel: process.env.LOG_LEVEL ?? "info",
  };
}
