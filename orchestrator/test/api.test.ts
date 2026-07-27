import { expect, test } from "bun:test";
import { createApp } from "../src/api/app.ts";
import type { Logger } from "../src/logger.ts";
import type { DashboardService } from "../src/services/dashboard-service.ts";
import type { InstanceController } from "../src/services/instance-controller.ts";
import type { QueueService } from "../src/services/queue-service.ts";

function testApp() {
  const dashboard = {
    getCluster: async () => ({
      schemaVersion: 1 as const,
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
      groups: [],
    }),
    getQueue: async () => null,
    getInstance: async () => null,
    getSession: async () => null,
  } as unknown as DashboardService;
  return createApp({
    dashboard,
    queues: {} as unknown as QueueService,
    instances: {} as unknown as InstanceController,
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
    schemaVersion: 1,
    summary: { activeInstances: 0 },
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
