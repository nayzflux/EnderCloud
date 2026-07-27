import { describe, expect, test } from "bun:test";
import {
  assembleClusterSnapshot,
  normalizeDashboardLimit,
  type DashboardRows,
} from "../../src/services/dashboard-service.ts";

const now = new Date("2026-07-27T12:00:00.000Z");

function rows(): DashboardRows {
  return {
    groups: [
      {
        id: "skywars-solo",
        type: "minigame",
        enabled: true,
        minimum_players: 4,
        maximum_players: 12,
        team_count: 12,
        team_size: 1,
        waiting_timeout_ms: 45_000,
        minimum_instances: 0,
        maximum_instances: 20,
        minimum_warm_instances: 2,
        maximum_warm_instances: 4,
        maximum_players_per_instance: null,
        target_players_per_instance: null,
        startup_timeout_ms: 90_000,
        draining_timeout_ms: 900_000,
        shutdown_timeout_ms: 20_000,
      },
      {
        id: "disabled-hub",
        type: "hub",
        enabled: false,
        minimum_players: null,
        maximum_players: null,
        team_count: null,
        team_size: null,
        waiting_timeout_ms: null,
        minimum_instances: 0,
        maximum_instances: 2,
        minimum_warm_instances: 0,
        maximum_warm_instances: 1,
        maximum_players_per_instance: 100,
        target_players_per_instance: 70,
        startup_timeout_ms: 90_000,
        draining_timeout_ms: 300_000,
        shutdown_timeout_ms: 20_000,
      },
    ],
    variants: [
      {
        id: "skywars-japan",
        group_id: "skywars-solo",
        enabled: true,
        revision: 2,
        selection_weight: 100,
        runtime_spec: {
          image: "itzg/minecraft-server:java25",
          memoryBytes: 4 * 1024 ** 3,
          cpu: 2,
          environment: {},
        },
      },
    ],
    instances: [
      instance("warm-instance-01", "RUNNING", "OPEN", null),
      instance("pending-warm-001", "STARTING", "OPEN", null),
      instance("reserved-game-01", "RUNNING", "RESERVED", "active-session01"),
      instance("failed-instance1", "FAILED", "OPEN", null),
    ],
    sessions: [
      session("active-session01", "reserved-game-01", "RUNNING"),
      session("waiting-session1", null, "WAITING_FOR_INSTANCE"),
    ],
    queues: [
      {
        group_id: "skywars-solo",
        party_count: 3,
        player_count: 5,
        oldest_joined_at: "2026-07-27T11:59:00.000Z",
      },
    ],
  };
}

function instance(
  id: string,
  lifecycle: "RUNNING" | "STARTING" | "FAILED",
  availability: "OPEN" | "RESERVED",
  sessionId: string | null,
) {
  return {
    id,
    group_id: "skywars-solo",
    variant_id: "skywars-japan",
    session_id: sessionId,
    lifecycle_state: lifecycle,
    availability_state: availability,
    endpoint: lifecycle === "RUNNING" ? `${id}:25565` : null,
    player_count: sessionId ? 4 : 0,
    maximum_players: 12,
    created_at: now.toISOString(),
    starting_at: lifecycle === "STARTING" ? now.toISOString() : null,
    running_at: lifecycle === "RUNNING" ? now.toISOString() : null,
    draining_at: null,
    drain_deadline: null,
    updated_at: now.toISOString(),
  } as const;
}

function session(
  id: string,
  instanceId: string | null,
  state: "RUNNING" | "WAITING_FOR_INSTANCE",
) {
  return {
    id,
    group_id: "skywars-solo",
    instance_id: instanceId,
    state,
    assignment_revision: 1,
    assignment_acknowledged_at: null,
    waiting_deadline: "2026-07-27T12:01:00.000Z",
    retry_count: 0,
    active_player_count: 4,
    connected_player_count: state === "RUNNING" ? 4 : 0,
    team_count: 4,
    created_at: now.toISOString(),
    started_at: state === "RUNNING" ? now.toISOString() : null,
    finished_at: null,
    updated_at: now.toISOString(),
  } as const;
}

describe("dashboard snapshot", () => {
  test("groups instances, both pool states and attached sessions", () => {
    const snapshot = assembleClusterSnapshot(rows(), now);
    const group = snapshot.groups.find((candidate) => candidate.id === "skywars-solo");
    expect(group?.capacity).toEqual({
      minimumInstances: 0,
      maximumInstances: 20,
      minimumWarmInstances: 2,
      maximumWarmInstances: 4,
      activeInstances: 3,
      warmInstances: 1,
      pendingWarmInstances: 1,
      reservedInstances: 1,
    });
    expect(group?.queue.playerCount).toBe(5);
    expect(group?.sessions.find((candidate) => candidate.id === "active-session01"))
      .toMatchObject({ instanceId: "reserved-game-01", state: "RUNNING" });
    expect(group?.sessions.find((candidate) => candidate.id === "waiting-session1"))
      .toMatchObject({ instanceId: null, state: "WAITING_FOR_INSTANCE" });
    expect(snapshot.groups.find((candidate) => candidate.id === "disabled-hub"))
      .toMatchObject({ enabled: false });
    expect(snapshot.summary.enabledGroups).toBe(1);
    expect(snapshot.summary.activeSessions).toBe(2);
  });

  test("keeps queue limits bounded", () => {
    expect(normalizeDashboardLimit(undefined)).toBe(50);
    expect(normalizeDashboardLimit(0)).toBe(1);
    expect(normalizeDashboardLimit(500)).toBe(200);
  });
});
