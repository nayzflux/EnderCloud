import { expect, test } from "@playwright/test";

const cluster = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  summary: {
    enabledGroups: 1,
    activeInstances: 1,
    runningInstances: 1,
    warmInstances: 0,
    pendingWarmInstances: 0,
    reservedInstances: 1,
    playersOnline: 4,
    activeSessions: 1,
    queuedParties: 2,
    queuedPlayers: 3,
  },
  groups: [
    {
      id: "skywars-solo",
      type: "minigame",
      enabled: true,
      capacity: {
        minimumInstances: 0,
        maximumInstances: 20,
        minimumWarmInstances: 2,
        maximumWarmInstances: 4,
        activeInstances: 1,
        warmInstances: 0,
        pendingWarmInstances: 0,
        reservedInstances: 1,
      },
      lifecycle: {
        startupTimeoutMs: 90_000,
        drainingTimeoutMs: 900_000,
        shutdownTimeoutMs: 20_000,
      },
      matchmaking: {
        minimumPlayers: 4,
        maximumPlayers: 12,
        teamCount: 12,
        teamSize: 1,
        waitingTimeoutMs: 45_000,
      },
      routing: null,
      queue: {
        partyCount: 2,
        playerCount: 3,
        oldestJoinedAt: new Date(Date.now() - 30_000).toISOString(),
      },
      variants: [
        {
          id: "skywars-japan",
          enabled: true,
          revision: 2,
          weight: 100,
          runtime: {
            image: "itzg/minecraft-server:java25",
            memoryBytes: 4 * 1024 ** 3,
            cpu: 2,
            environment: {},
          },
        },
      ],
      instances: [
        {
          id: "abcdefghijklmnop",
          variantId: "skywars-japan",
          sessionId: "qrstuvwxyzABCDEF",
          lifecycleState: "RUNNING",
          availabilityState: "RESERVED",
          endpoint: "server:25565",
          playerCount: 4,
          maximumPlayers: 12,
          createdAt: new Date(Date.now() - 120_000).toISOString(),
          startingAt: new Date(Date.now() - 110_000).toISOString(),
          runningAt: new Date(Date.now() - 90_000).toISOString(),
          drainingAt: null,
          drainDeadline: null,
          updatedAt: new Date().toISOString(),
        },
      ],
      sessions: [
        {
          id: "qrstuvwxyzABCDEF",
          instanceId: "abcdefghijklmnop",
          state: "RUNNING",
          assignmentRevision: 1,
          assignmentAcknowledgedAt: new Date().toISOString(),
          waitingDeadline: new Date(Date.now() + 60_000).toISOString(),
          retryCount: 0,
          activePlayerCount: 4,
          connectedPlayerCount: 4,
          teamCount: 4,
          createdAt: new Date(Date.now() - 120_000).toISOString(),
          startedAt: new Date(Date.now() - 30_000).toISOString(),
          finishedAt: null,
          updatedAt: new Date().toISOString(),
        },
      ],
    },
  ],
};

const instanceDetail = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  instance: {
    ...cluster.groups[0].instances[0],
    groupId: "skywars-solo",
    groupType: "minigame",
    containerId: "docker-container",
    runtimePath: "/data/runtime/abcdefghijklmnop",
    stoppedAt: null,
  },
  variant: {
    ...cluster.groups[0].variants[0],
    checksum: "abc123",
  },
  players: [],
  session: cluster.groups[0].sessions[0],
  commands: [],
  events: [],
};

test.beforeEach(async ({ page }) => {
  await page.route("**/api/cluster", async (route) => {
    await route.fulfill({ json: cluster });
  });
  await page.route("**/api/instances/abcdefghijklmnop", async (route) => {
    await route.fulfill({ json: instanceDetail });
  });
});

test("renders the topology and opens instance details", async (
  { page },
  testInfo,
) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Topologie du cluster" }),
  ).toBeVisible();
  await expect(page.getByText("skywars-solo").first()).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("dashboard.png"),
    fullPage: true,
  });
  await page.getByText("abcdefghijklmnop").click();
  await expect(page.getByRole("heading", { name: "Instance" })).toBeVisible();
  await expect(page.getByText("docker-container")).toBeVisible();
});

test("keeps filters and refresh controls usable on a narrow viewport", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile");
  await page.goto("/");
  await expect(
    page.getByLabel("Rechercher une instance, variante ou session"),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Actualiser" })).toBeVisible();
  await expect(page.getByLabel("Carte du cluster")).toBeVisible();
});
