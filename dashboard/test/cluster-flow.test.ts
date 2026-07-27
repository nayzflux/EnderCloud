import { describe, expect, test } from "bun:test";
import { buildClusterFlow } from "../src/lib/cluster-flow";
import type { DashboardClusterSnapshot } from "../src/lib/contracts";

const snapshot: DashboardClusterSnapshot = {
  schemaVersion: 1,
  generatedAt: "2026-07-27T12:00:00.000Z",
  summary: {
    enabledGroups: 1,
    activeInstances: 2,
    runningInstances: 1,
    warmInstances: 0,
    pendingWarmInstances: 1,
    reservedInstances: 1,
    playersOnline: 4,
    activeSessions: 2,
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
        activeInstances: 2,
        warmInstances: 0,
        pendingWarmInstances: 1,
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
        oldestJoinedAt: "2026-07-27T11:59:00.000Z",
      },
      variants: [],
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
          createdAt: "2026-07-27T11:58:00.000Z",
          startingAt: "2026-07-27T11:58:01.000Z",
          runningAt: "2026-07-27T11:58:20.000Z",
          drainingAt: null,
          drainDeadline: null,
          updatedAt: "2026-07-27T12:00:00.000Z",
        },
        {
          id: "startingInstance",
          variantId: "skywars-japan",
          sessionId: null,
          lifecycleState: "STARTING",
          availabilityState: "OPEN",
          endpoint: null,
          playerCount: 0,
          maximumPlayers: 12,
          createdAt: "2026-07-27T11:59:30.000Z",
          startingAt: "2026-07-27T11:59:31.000Z",
          runningAt: null,
          drainingAt: null,
          drainDeadline: null,
          updatedAt: "2026-07-27T12:00:00.000Z",
        },
      ],
      sessions: [
        {
          id: "qrstuvwxyzABCDEF",
          instanceId: "abcdefghijklmnop",
          state: "RUNNING",
          assignmentRevision: 1,
          assignmentAcknowledgedAt: "2026-07-27T11:58:30.000Z",
          waitingDeadline: "2026-07-27T12:01:00.000Z",
          retryCount: 0,
          activePlayerCount: 4,
          connectedPlayerCount: 4,
          teamCount: 4,
          createdAt: "2026-07-27T11:58:00.000Z",
          startedAt: "2026-07-27T11:59:00.000Z",
          finishedAt: null,
          updatedAt: "2026-07-27T12:00:00.000Z",
        },
        {
          id: "waitingSessionAB",
          instanceId: null,
          state: "WAITING_FOR_INSTANCE",
          assignmentRevision: 1,
          assignmentAcknowledgedAt: null,
          waitingDeadline: "2026-07-27T12:01:00.000Z",
          retryCount: 0,
          activePlayerCount: 4,
          connectedPlayerCount: 0,
          teamCount: 4,
          createdAt: "2026-07-27T11:59:40.000Z",
          startedAt: null,
          finishedAt: null,
          updatedAt: "2026-07-27T12:00:00.000Z",
        },
      ],
    },
  ],
};

describe("cluster flow layout", () => {
  test("creates stable group, queue, pool, instance and attached session nodes", () => {
    const first = buildClusterFlow(snapshot, {
      groupId: "all",
      state: "all",
      search: "",
    });
    const second = buildClusterFlow(snapshot, {
      groupId: "all",
      state: "all",
      search: "",
    });
    expect(first.nodes.map((node) => node.id)).toEqual(
      second.nodes.map((node) => node.id),
    );
    expect(new Set(first.nodes.map((node) => node.type))).toEqual(
      new Set(["group", "queue", "pool", "instance", "session"]),
    );
    expect(
      first.edges.find(
        (edge) =>
          edge.source === "instance:abcdefghijklmnop" &&
          edge.target === "session:qrstuvwxyzABCDEF",
      ),
    ).toBeDefined();
    expect(
      first.edges.find(
        (edge) =>
          edge.source === "pool:skywars-solo" &&
          edge.target === "session:waitingSessionAB",
      )?.style,
    ).toMatchObject({ strokeDasharray: "5 6" });
  });

  test("filters the topology by state and search", () => {
    const starting = buildClusterFlow(snapshot, {
      groupId: "all",
      state: "starting",
      search: "",
    });
    expect(starting.nodes.some((node) => node.id === "instance:startingInstance"))
      .toBeTrue();
    expect(starting.nodes.some((node) => node.id === "instance:abcdefghijklmnop"))
      .toBeFalse();

    const searched = buildClusterFlow(snapshot, {
      groupId: "all",
      state: "all",
      search: "server:25565",
    });
    expect(searched.nodes.some((node) => node.id === "instance:abcdefghijklmnop"))
      .toBeTrue();
    expect(searched.nodes.some((node) => node.id === "instance:startingInstance"))
      .toBeFalse();
  });
});
