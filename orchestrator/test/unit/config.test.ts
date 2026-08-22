import { describe, expect, test } from "bun:test";
import { loadConfig } from "../../src/config.ts";
import { loadAgentConfig } from "../../src/agent/config.ts";

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
    expect(() => loadConfig({ ...database, ORCHESTRATOR_PORT: "8080" }))
      .toThrow("use ORCHESTRATOR_LISTEN_PORT");
    expect(() => loadConfig({ ...database, ORCHESTRATOR_LOG_LEVEL: "verbose" }))
      .toThrow("debug, info, warn or error");
    expect(() => loadConfig({ ...database, INSTANCE_START_CONCURRENCY: "65" }))
      .toThrow("between 1 and 64");
    expect(() => loadConfig({ DATABASE_URL: "https://database.invalid" }))
      .toThrow("postgres:");
    expect(() => loadConfig({ DATABASE_URL: "postgres://endercloud@database:5432/endercloud" }))
      .toThrow("explicit PostgreSQL password");
    expect(() => loadConfig({})).toThrow("DATABASE_URL is required");
  });

  test("validates the agent network, resources and published game ports", () => {
    const environment = {
      AGENT_ID: "test-host",
      AGENT_ADVERTISED_CONTROL_URL: "http://agent:8090",
      AGENT_ADVERTISED_GAME_ADDRESS: "10.0.0.10",
      AGENT_ALLOCATABLE_CPU: "4",
      AGENT_ALLOCATABLE_MEMORY_BYTES: "8589934592",
      AGENT_RUNTIME_HOST_DIRECTORY: "/data/runtime",
      ORCHESTRATOR_URL: "http://orchestrator:8080",
      AGENT_HEARTBEAT_INTERVAL: "5s",
    } as const;
    expect(loadAgentConfig(environment)).toMatchObject({
      hostId: "test-host",
      heartbeatIntervalMs: 5_000,
      portStart: 25_565,
      portEnd: 25_664,
    });
    expect(() => loadAgentConfig({ ...environment, AGENT_GAME_PORT_START: "70000" }))
      .toThrow("between 1 and 65535");
    expect(() => loadAgentConfig({ ...environment, ORCHESTRATOR_URL: "redis://redis:6379" }))
      .toThrow("http:");
  });
});
