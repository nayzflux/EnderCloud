import { expect, mock, test } from "bun:test";
import { createAgentApp } from "../../src/agent/app.ts";
import type { AgentConfig } from "../../src/agent/config.ts";
import type { TemplateCache } from "../../src/agent/template-cache.ts";
import type { LocalDockerExecutor } from "../../src/executor/local-docker.ts";
import { Logger } from "../../src/logger.ts";

const instanceId = "agentinstance001";
const checksum = "a".repeat(64);

test("agent API delegates idempotent instance operations to the local executor", async () => {
  const records: Record<string, unknown>[] = [];
  const logger = new Logger("debug", {
    service: "test-agent",
    sink: (_level, record) => records.push(JSON.parse(record)),
  });
  const createInstance = mock(async () => ({
    containerId: "container-01",
    runtimePath: "/data/runtime/instances/agentinstance001",
    endpoint: "10.20.0.11:25565",
  }));
  const stopInstance = mock(async () => {});
  const deleteInstance = mock(async () => {});
  const inspectInstance = mock(async () => ({ exists: true, running: true }));
  const listManagedInstances = mock(async () => []);
  const getInstanceLogs = mock(async () => {
    logger.info("docker.logs.collected", "Instance logs collected");
    return "last server line";
  });
  const executor = {
    createInstance,
    stopInstance,
    deleteInstance,
    inspectInstance,
    listManagedInstances,
    getInstanceLogs,
  } as unknown as LocalDockerExecutor;
  const resolveLayers = mock(async () => [
    { id: "base-layer", checksum, templatePath: "/cache/base-layer/checksum" },
  ]);
  const templates = { resolveLayers } as unknown as TemplateCache;
  const config = { hostId: "host-paris-01" } as AgentConfig;
  const app = createAgentApp(config, executor, templates, logger);

  const body = {
    hostId: "host-paris-01",
    instanceId,
    groupId: "skywars-solo",
    variantId: "skywars-map-a",
    templateLayers: [{ id: "base-layer", checksum }],
    runtime: {
      image: "itzg/minecraft-server:java25",
      memoryBytes: 1024 ** 3,
      cpu: 1,
      environment: {},
    },
    environment: {},
  };
  const createResponse = await app.handle(new Request(
    `http://agent/api/v1/instances/${instanceId}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  ));
  expect(createResponse.status).toBe(200);
  expect(await createResponse.json()).toMatchObject({
    containerId: "container-01",
    endpoint: "10.20.0.11:25565",
  });
  expect(resolveLayers).toHaveBeenCalledWith(body.templateLayers);
  expect(createInstance).toHaveBeenCalledTimes(1);

  const inspectResponse = await app.handle(new Request(
    `http://agent/api/v1/instances/${instanceId}`,
  ));
  expect(inspectResponse.status).toBe(200);
  expect(inspectInstance).toHaveBeenCalledWith({
    hostId: "host-paris-01",
    instanceId,
  });

  const stopResponse = await app.handle(new Request(
    `http://agent/api/v1/instances/${instanceId}/stop`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ timeoutSeconds: 20 }),
    },
  ));
  expect(stopResponse.status).toBe(204);
  expect(stopInstance).toHaveBeenCalledWith(
    { hostId: "host-paris-01", instanceId },
    20,
  );

  const deleteResponse = await app.handle(new Request(
    `http://agent/api/v1/instances/${instanceId}`,
    { method: "DELETE" },
  ));
  expect(deleteResponse.status).toBe(204);
  expect(deleteInstance).toHaveBeenCalledWith({
    hostId: "host-paris-01",
    instanceId,
  });

  const logsResponse = await app.handle(new Request(
    `http://agent/api/v1/instances/${instanceId}/logs?lines=200&maxBytes=65536`,
    { headers: { "x-request-id": "request-123", "x-command-id": "command-123" } },
  ));
  expect(logsResponse.status).toBe(200);
  expect(logsResponse.headers.get("x-request-id")).toBe("request-123");
  expect(await logsResponse.json()).toEqual({ logs: "last server line" });
  expect(getInstanceLogs).toHaveBeenCalledWith(
    { hostId: "host-paris-01", instanceId },
    200,
    65536,
  );
  expect(records.find((record) => record.event === "docker.logs.collected")).toMatchObject({
    requestId: "request-123",
    commandId: "command-123",
  });
  await Bun.sleep(0);
  expect(records.filter((record) =>
    record.event === "agent.request.completed" &&
    record.route === "/api/v1/instances/:instanceId/logs"
  )).toHaveLength(1);
});

test("agent refuses a create request addressed to another host", async () => {
  const createInstance = mock(async () => ({
    containerId: "never",
    runtimePath: "never",
    endpoint: "never",
  }));
  const app = createAgentApp(
    { hostId: "host-paris-01" } as AgentConfig,
    { createInstance } as unknown as LocalDockerExecutor,
    { resolveLayers: mock(async () => []) } as unknown as TemplateCache,
  );
  const response = await app.handle(new Request(
    `http://agent/api/v1/instances/${instanceId}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        hostId: "host-paris-02",
        instanceId,
        groupId: "skywars-solo",
        variantId: "skywars-map-a",
        templateLayers: [{ id: "base-layer", checksum }],
        runtime: {
          image: "image:tag",
          memoryBytes: 1024,
          cpu: 1,
          environment: {},
        },
        environment: {},
      }),
    },
  ));

  expect(response.status).toBe(500);
  expect(createInstance).not.toHaveBeenCalled();
});
