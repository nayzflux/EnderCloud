import { expect, mock, test } from "bun:test";
import { createApp } from "../../src/api/app.ts";
import type { Logger } from "../../src/logger.ts";
import type { DashboardService } from "../../src/services/dashboard-service.ts";
import type { InstanceController } from "../../src/services/instance-controller.ts";
import type { QueueService } from "../../src/services/queue-service.ts";
import type { HubRouter } from "../../src/services/hub-router.ts";
import type { MonitoringService } from "../../src/services/monitoring-service.ts";
import type { HostService } from "../../src/services/host-service.ts";
import type { TemplateArchiveService } from "../../src/services/template-archive-service.ts";

function testApp(
  hubs: HubRouter = {} as HubRouter,
  instances: InstanceController = {} as InstanceController,
  monitoring: MonitoringService = {
    getSummary: async () => ({ schemaVersion: 1, generatedAt: new Date().toISOString(), alerts: [] }),
    getGroupSeries: async () => null,
  } as unknown as MonitoringService,
  hosts: HostService = {} as HostService,
  templates: TemplateArchiveService = {} as TemplateArchiveService,
) {
  const dashboard = {
    getCluster: async () => ({
      schemaVersion: 3 as const,
      generatedAt: "2026-07-27T12:00:00.000Z",
      summary: {
        enabledGroups: 0,
        activeInstances: 0,
        runningInstances: 0,
        warmInstances: 0,
        pendingWarmInstances: 0,
        reservedInstances: 0,
        playersOnline: 0,
        activeSessions: 0,
        queuedParties: 0,
        queuedPlayers: 0,
      },
      hosts: [],
      groups: [],
    }),
    getQueue: async () => null,
    getInstance: async () => null,
    getSession: async () => null,
  } as unknown as DashboardService;
  return createApp({
    dashboard,
    monitoring,
    queues: {} as unknown as QueueService,
    instances,
    hubs,
    hosts,
    templates,
    logger: { error: () => {} } as unknown as Logger,
    isReady: () => true,
  });
}

test("dashboard cluster endpoint returns a versioned snapshot", async () => {
  const response = await testApp().handle(
    new Request("http://endercloud/api/v1/dashboard/cluster"),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    schemaVersion: 3,
    summary: { activeInstances: 0 },
  });
});

test("Paper heartbeats accept optional TPS and reject invalid samples", async () => {
  const received: unknown[] = [];
  const instances = {
    handlePaperEvent: async (_instanceId: string, event: unknown) => {
      received.push(event);
    },
  } as unknown as InstanceController;
  const endpoint = "http://endercloud/api/v1/instances/abcdefghijklmnop/events";

  for (const body of [
    { type: "HEARTBEAT", playerIds: [] },
    {
      type: "HEARTBEAT",
      playerIds: [],
      tps: { oneMinute: 19.9, fiveMinutes: 19.8, fifteenMinutes: 19.7 },
    },
  ]) {
    const response = await testApp({} as HubRouter, instances).handle(
      new Request(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    expect(response.status).toBe(202);
  }
  expect(received).toHaveLength(2);

  const invalid = await testApp({} as HubRouter, instances).handle(
    new Request(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "HEARTBEAT",
        playerIds: [],
        tps: { oneMinute: -1, fiveMinutes: 20, fifteenMinutes: 20 },
      }),
    }),
  );
  expect(invalid.status).toBe(400);
});

test("monitoring endpoints expose summaries and validate ranges", async () => {
  const monitoring = {
    getSummary: async () => ({
      schemaVersion: 1 as const,
      generatedAt: "2026-08-01T12:00:00.000Z",
      alerts: [],
    }),
    getGroupSeries: async (groupId: string, range: string) => ({
      schemaVersion: 1 as const,
      generatedAt: "2026-08-01T12:00:00.000Z",
      groupId,
      range,
      resolutionMs: 60_000,
      thresholds: { tps: 19, startupBootMs: 54_000 },
      variants: [],
    }),
  } as unknown as MonitoringService;

  const summary = await testApp({} as HubRouter, {} as InstanceController, monitoring)
    .handle(new Request("http://endercloud/api/v1/dashboard/monitoring/summary"));
  expect(summary.status).toBe(200);
  expect(await summary.json()).toMatchObject({ schemaVersion: 1, alerts: [] });

  const series = await testApp({} as HubRouter, {} as InstanceController, monitoring)
    .handle(new Request(
      "http://endercloud/api/v1/dashboard/groups/skywars-solo/monitoring?range=24h",
    ));
  expect(series.status).toBe(200);
  expect(await series.json()).toMatchObject({ groupId: "skywars-solo", range: "24h" });

  const invalid = await testApp({} as HubRouter, {} as InstanceController, monitoring)
    .handle(new Request(
      "http://endercloud/api/v1/dashboard/groups/skywars-solo/monitoring?range=30d",
    ));
  expect(invalid.status).toBe(400);
});

test("Paper can schedule a balanced hub transfer", async () => {
  const playerId = "02a1c31e-4748-4106-932d-a780413d7b9a";
  const hubs = {
    transferPlayers: async (instanceId: string, playerIds: readonly string[]) => {
      expect(instanceId).toBe("abcdefghijklmnop");
      expect(playerIds).toEqual([playerId]);
      return { acceptedPlayers: [playerId], rejectedPlayers: [] };
    },
  } as unknown as HubRouter;
  const response = await testApp(hubs).handle(
    new Request(
      "http://endercloud/api/v1/instances/abcdefghijklmnop/hub-transfers",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ playerIds: [playerId] }),
      },
    ),
  );
  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({
    acceptedPlayers: [playerId],
    rejectedPlayers: [],
  });
});

test("dashboard detail endpoints return a stable 404 response", async () => {
  const response = await testApp().handle(
    new Request(
      "http://endercloud/api/v1/dashboard/instances/abcdefghijklmnop",
      { headers: { "x-request-id": "dashboard-test" } },
    ),
  );
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({
    error: "NOT_FOUND",
    message: "Instance abcdefghijklmnop was not found",
    requestId: "dashboard-test",
  });
});

test("host control routes validate heartbeats and preserve action conflicts", async () => {
  const heartbeat = mock(async () => {});
  const requestDrain = mock(async () => true);
  const activate = mock(async () => false);
  const hosts = {
    heartbeat,
    requestDrain,
    activate,
  } as unknown as HostService;
  const app = testApp(
    {} as HubRouter,
    {} as InstanceController,
    undefined,
    hosts,
  );

  const heartbeatBody = {
    controlUrl: "http://host-paris-01:8090",
    gameAddress: "10.20.0.11",
    allocatableCpu: 8,
    allocatableMemoryBytes: 16 * 1024 ** 3,
    agentVersion: "0.1.0",
  };
  const heartbeatResponse = await app.handle(new Request(
    "http://endercloud/api/v1/hosts/host-paris-01/heartbeat",
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(heartbeatBody),
    },
  ));
  expect(heartbeatResponse.status).toBe(204);
  expect(heartbeat).toHaveBeenCalledWith("host-paris-01", heartbeatBody);

  const drainResponse = await app.handle(new Request(
    "http://endercloud/api/v1/hosts/host-paris-01/drain",
    { method: "POST" },
  ));
  expect(drainResponse.status).toBe(200);
  expect(await drainResponse.json()).toEqual({ accepted: true });

  const activateResponse = await app.handle(new Request(
    "http://endercloud/api/v1/hosts/host-paris-01/activate",
    { method: "POST" },
  ));
  expect(activateResponse.status).toBe(409);
  expect(await activateResponse.json()).toEqual({ accepted: false });
});

test("template archive route streams the service response", async () => {
  const checksum = "a".repeat(64);
  const open = mock(async () => new Response("archive", {
    headers: { "content-type": "application/x-tar" },
  }));
  const templates = { open } as unknown as TemplateArchiveService;
  const response = await testApp(
    {} as HubRouter,
    {} as InstanceController,
    undefined,
    {} as HostService,
    templates,
  ).handle(new Request(
    `http://endercloud/api/v1/template-layers/base-layer/archive?checksum=${checksum}`,
  ));

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("application/x-tar");
  expect(await response.text()).toBe("archive");
  expect(open).toHaveBeenCalledWith("base-layer", checksum);
});
