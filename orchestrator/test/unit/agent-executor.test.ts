import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { AgentExecutor } from "../../src/executor/agent-executor.ts";
import { ExecutionHostUnavailableError } from "../../src/executor/executor.ts";
import { Logger } from "../../src/logger.ts";
import type { HostService } from "../../src/services/host-service.ts";

afterEach(() => {
  mock.restore();
});

test("agent executor propagates request and command context headers", async () => {
  let receivedHeaders = new Headers();
  const fetchMock = (async (_input: string | URL | Request, init?: RequestInit) => {
    receivedHeaders = new Headers(init?.headers);
    return Response.json([]);
  }) as unknown as typeof fetch;
  spyOn(globalThis, "fetch").mockImplementation(fetchMock);
  const hosts = {
    getTarget: async () => ({ controlUrl: "http://agent:8090" }),
    recordControlSuccess: async () => {},
    recordControlFailure: async () => {},
  } as unknown as HostService;
  const logger = new Logger("debug", { sink: () => {} });
  const executor = new AgentExecutor(hosts, {
    probeTimeoutMs: 1_000,
    operationTimeoutMs: 10_000,
  }, logger);

  await logger.runWithContext({ requestId: "request-123", commandId: "command-123" }, () =>
    executor.listManagedInstances("host-1")
  );

  expect(receivedHeaders.get("x-request-id")).toBe("request-123");
  expect(receivedHeaders.get("x-command-id")).toBe("command-123");
});

test("agent executor distinguishes transport outages from agent failures", async () => {
  let mode: "offline" | "response" = "offline";
  const fetchMock = (async () => {
    if (mode === "offline") throw new TypeError("connection refused");
    return new Response("docker create failed", { status: 500 });
  }) as unknown as typeof fetch;
  spyOn(globalThis, "fetch").mockImplementation(fetchMock);
  let controlSuccesses = 0;
  let controlFailures = 0;
  const hosts = {
    getTarget: async () => ({ controlUrl: "http://agent:8090" }),
    recordControlSuccess: async () => { controlSuccesses += 1; },
    recordControlFailure: async () => { controlFailures += 1; },
  } as unknown as HostService;
  const executor = new AgentExecutor(hosts, {
    probeTimeoutMs: 1_000,
    operationTimeoutMs: 10_000,
  }, new Logger("error", { sink: () => {} }));

  const outage = await executor.listManagedInstances("host-1").catch((error) => error);
  expect(outage).toBeInstanceOf(ExecutionHostUnavailableError);
  mode = "response";
  const rejected = await executor.listManagedInstances("host-1").catch((error) => error);
  expect(rejected).toBeInstanceOf(Error);
  expect(rejected).not.toBeInstanceOf(ExecutionHostUnavailableError);
  expect(controlFailures).toBe(1);
  expect(controlSuccesses).toBe(1);
});
