import { describe, expect, test } from "bun:test";
import {
  activeInstanceDeadline,
  activeSessionDeadline,
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
        instance_acquisition_timeout_ms: 45_000,
        lobby_stale_timeout_ms: 135_000,
        minimum_instances: 0,
        maximum_instances: 20,
        minimum_warm_instances: 2,
        maximum_warm_instances: 4,
        maximum_players_per_instance: null,
        target_players_per_instance: null,
        startup_timeout_ms: 90_000,
        drain_timeout_ms: 900_000,
        cancelled_drain_timeout_ms: 10_000,
        shutdown_timeout_ms: 20_000,
        transfer_timeout_ms: 20_000,
        player_stale_timeout_ms: 30_000,
        instance_lifetime_ms: null,
      },
      {
        id: "disabled-hub",
        type: "hub",
        enabled: false,
        minimum_players: null,
        maximum_players: null,
        team_count: null,
        team_size: null,
        instance_acquisition_timeout_ms: null,
        lobby_stale_timeout_ms: null,
        minimum_instances: 0,
        maximum_instances: 2,
        minimum_warm_instances: 0,
        maximum_warm_instances: 1,
        maximum_players_per_instance: 100,
        target_players_per_instance: 70,
        startup_timeout_ms: 90_000,
        drain_timeout_ms: 300_000,
        cancelled_drain_timeout_ms: 10_000,
        shutdown_timeout_ms: 20_000,
        transfer_timeout_ms: 20_000,
        player_stale_timeout_ms: 30_000,
        instance_lifetime_ms: 14_400_000,
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
    incidentSummary: { active: 2, critical: 1 },
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
    startup_deadline:
      lifecycle === "STARTING" ? "2026-07-27T12:01:30.000Z" : null,
    running_at: lifecycle === "RUNNING" ? now.toISOString() : null,
    renewal_deadline: null,
    replaces_instance_id: null,
    draining_at: null,
    drain_deadline: null,
    drain_reason: null,
    stopping_at: null,
    shutdown_deadline: null,
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
    instance_acquisition_deadline:
      state === "WAITING_FOR_INSTANCE" ? "2026-07-27T12:01:00.000Z" : null,
    lobby_stale_deadline: null,
    retry_count: 0,
    maximum_player_count: 12,
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
      .toMatchObject({
        instanceId: "reserved-game-01",
        state: "RUNNING",
        maximumPlayerCount: 12,
      });
    expect(group?.sessions.find((candidate) => candidate.id === "waiting-session1"))
      .toMatchObject({ instanceId: null, state: "WAITING_FOR_INSTANCE" });
    expect(snapshot.groups.find((candidate) => candidate.id === "disabled-hub"))
      .toMatchObject({ enabled: false });
    expect(snapshot.summary.enabledGroups).toBe(1);
    expect(snapshot.summary.activeSessions).toBe(2);
    expect(snapshot.schemaVersion).toBe(4);
    expect(snapshot.summary.activeIncidentCount).toBe(2);
    expect(snapshot.summary.criticalIncidentCount).toBe(1);
  });

  test("keeps queue limits bounded", () => {
    expect(normalizeDashboardLimit(undefined)).toBe(50);
    expect(normalizeDashboardLimit(0)).toBe(1);
    expect(normalizeDashboardLimit(500)).toBe(200);
  });

  test("selects only the deadline that can advance an instance", () => {
    const starting = instance("pending-warm-001", "STARTING", "OPEN", null);
    expect(activeInstanceDeadline(starting)).toEqual({
      kind: "INSTANCE_STARTUP",
      at: "2026-07-27T12:01:30.000Z",
    });
    expect(activeInstanceDeadline(instance("ready", "RUNNING", "OPEN", null))).toBeNull();
    expect(activeInstanceDeadline({
      ...instance("renewing", "RUNNING", "OPEN", null),
      renewal_deadline: "2026-07-27T16:00:00.000Z",
    })).toEqual({
      kind: "INSTANCE_RENEWAL",
      at: "2026-07-27T16:00:00.000Z",
    });

    expect(activeInstanceDeadline({
      ...starting,
      lifecycle_state: "DRAINING",
      startup_deadline: null,
      draining_at: now.toISOString(),
      drain_deadline: "2026-07-27T12:00:10.000Z",
      drain_reason: "SESSION_CANCELLED",
    })).toEqual({
      kind: "CANCELLED_INSTANCE_DRAIN",
      at: "2026-07-27T12:00:10.000Z",
    });
  });

  test("prioritizes session acquisition, transfers and lobby stale", () => {
    const waitingForInstance = session("waiting-session1", null, "WAITING_FOR_INSTANCE");
    expect(activeSessionDeadline(waitingForInstance, [])?.kind)
      .toBe("INSTANCE_ACQUISITION");

    const waiting = {
      ...session("waiting-session2", "instance-1", "RUNNING"),
      state: "WAITING" as const,
      lobby_stale_deadline: "2026-07-27T12:02:15.000Z",
    };
    expect(activeSessionDeadline(waiting, [{
      state: "PENDING",
      expires_at: "2026-07-27T12:00:20.000Z",
    }])?.kind).toBe("PLAYER_TRANSFER");
    expect(activeSessionDeadline(waiting, [])?.kind).toBe("LOBBY_STALE");
    expect(activeSessionDeadline({
      ...waiting,
      state: "FINISHED",
    }, [])).toBeNull();
  });
});
