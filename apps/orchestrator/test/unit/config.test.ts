import { describe, expect, test } from "bun:test";
import { loadConfig } from "../../src/config.ts";

describe("environment configuration", () => {
  const database = { DATABASE_URL: "postgres://endercloud:test@database:5432/endercloud" } as const;

  test("uses explicit units and production startup defaults", () => {
    const config = loadConfig({
      ...database,
      SCHEDULER_CAPACITY_INTERVAL: "750ms",
      EXECUTOR_OPERATION_TIMEOUT: "2m",
    });
    expect(config.capacityIntervalMs).toBe(750);
    expect(config.agentOperationTimeoutMs).toBe(120_000);
    expect(config.instanceStartConcurrency).toBe(4);
    expect(config.instanceStartRetryLimit).toBe(5);
    expect(config.instanceStartRetryBaseDelayMs).toBe(1_000);
  });

  test("rejects removed names and invalid log levels", () => {
    expect(() => loadConfig({ ...database, ORCHESTRATOR_PORT: "8080" })).toThrow(
      "use ORCHESTRATOR_LISTEN_PORT",
    );
    expect(() => loadConfig({ ...database, ORCHESTRATOR_LOG_LEVEL: "verbose" })).toThrow(
      "debug, info, warn or error",
    );
    expect(() => loadConfig({ ...database, INSTANCE_START_CONCURRENCY: "65" })).toThrow(
      "between 1 and 64",
    );
    expect(() => loadConfig({ DATABASE_URL: "https://database.invalid" })).toThrow("postgres:");
    expect(() =>
      loadConfig({ DATABASE_URL: "postgres://endercloud@database:5432/endercloud" }),
    ).toThrow("explicit PostgreSQL password");
    expect(() => loadConfig({})).toThrow("DATABASE_URL is required");
  });
});
