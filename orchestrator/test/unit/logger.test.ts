import { describe, expect, test } from "bun:test";
import { Logger, type LogLevel } from "../../src/logger.ts";

function capture(minimum: LogLevel = "debug") {
  const records: string[] = [];
  const logger = new Logger(minimum, {
    service: "test-service",
    version: "1.2.3",
    sink: (_level, record) => records.push(record),
  });
  return { logger, records };
}

describe("structured logger", () => {
  test("filters levels and emits stable JSON fields", () => {
    const { logger, records } = capture("info");
    logger.debug("test.hidden", "Hidden");
    logger.info("test.visible", "Visible", { durationMs: 12, outcome: "success" });
    expect(records).toHaveLength(1);
    expect(JSON.parse(records[0]!)).toMatchObject({
      level: "info",
      service: "test-service",
      version: "1.2.3",
      event: "test.visible",
      message: "Visible",
      durationMs: 12,
      outcome: "success",
    });
  });

  test("inherits context and protects reserved fields", async () => {
    const { logger, records } = capture();
    await logger.child({ component: "worker", hostId: "host-1" }).runWithContext(
      { requestId: "request-1", commandId: "command-1" },
      async () => logger.info("test.context", "Context", {
        event: "overwritten",
        level: "error",
      }),
    );
    expect(JSON.parse(records[0]!)).toMatchObject({
      event: "test.context",
      level: "info",
      requestId: "request-1",
      commandId: "command-1",
    });
  });

  test("serializes errors and removes secrets", () => {
    const { logger, records } = capture();
    const cause = new Error("redis://admin:secret@redis:6379/0?token=value");
    const error = new Error("request failed", { cause });
    logger.error("test.failed", "Operation failed", {
      error,
      password: "do-not-log",
      databaseUrl: "postgres://endercloud:secret@db:5432/endercloud?ssl=true",
    });
    const record = JSON.parse(records[0]!);
    expect(record.password).toBe("[redacted]");
    expect(record.databaseUrl).not.toContain("secret");
    expect(record.databaseUrl).not.toContain("ssl=true");
    expect(record.error.stack).toContain("Error: request failed");
    expect(JSON.stringify(record.error.cause)).not.toContain("secret");
  });

  test("bounds strings, arrays and nested objects", () => {
    const { logger, records } = capture();
    let nested: Record<string, unknown> = { value: "leaf" };
    for (let depth = 0; depth < 8; depth += 1) nested = { nested };
    logger.info("test.bounded", "Bounded", {
      text: "x".repeat(10_000),
      entries: Array.from({ length: 150 }, (_, index) => index),
      nested,
    });
    const record = JSON.parse(records[0]!);
    expect(record.text).toHaveLength(8_192);
    expect(record.entries).toHaveLength(100);
    expect(JSON.stringify(record.nested)).toContain("[truncated]");
  });
});
