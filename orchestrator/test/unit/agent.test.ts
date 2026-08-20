import { expect, mock, test } from "bun:test";
import { createAgentApp } from "../../src/agent/app.ts";
import type { AgentConfig } from "../../src/agent/config.ts";
import type { TemplateCache } from "../../src/agent/template-cache.ts";
import type { LocalDockerExecutor } from "../../src/executor/local-docker.ts";

const instanceId = "agentinstance001";
const checksum = "a".repeat(64);

test("agent API delegates idempotent instance operations to the local executor", async () => {
  const createInstance = mock(async () => ({
    containerId: "container-01",
    runtimePath: "/data/runtime/instances/agentinstance001",
    endpoint: "10.20.0.11:25565",
  }));
  const stopInstance = mock(async () => {});
  const deleteInstance = mock(async () => {});
  const inspectInstance = mock(async () => ({ exists: true, running: true }));
  const listManagedInstances = mock(async () => []);
  const executor = {
    createInstance,
    stopInstance,
    deleteInstance,
    inspectInstance,
    listManagedInstances,
  } as unknown as LocalDockerExecutor;
  const resolveLayers = mock(async () => [
    { id: "base-layer", checksum, templatePath: "/cache/base-layer/checksum" },
  ]);
  const templates = { resolveLayers } as unknown as TemplateCache;
  const config = { hostId: "host-paris-01" } as AgentConfig;
  const app = createAgentApp(config, executor, templates);

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
