import { describe, expect, test } from "bun:test";
import {
  isMockEnabled,
  mockCluster,
  mockGroupMonitoring,
  mockIncidents,
  mockInstance,
  mockMonitoringSummary,
  mockQueue,
  mockSession,
} from "../src/lib/mock-data";

const now = Date.parse("2026-07-27T12:00:00.000Z");
const internalIdPattern = /^[A-Za-z0-9]{16}$/;

describe("isMockEnabled", () => {
  const original = process.env.DASHBOARD_MOCK_DATA;
  const restore = () => {
    if (original === undefined) delete process.env.DASHBOARD_MOCK_DATA;
    else process.env.DASHBOARD_MOCK_DATA = original;
  };

  test("accepts the usual truthy spellings and nothing else", () => {
    for (const value of ["1", "true", "TRUE", "yes", "on"]) {
      process.env.DASHBOARD_MOCK_DATA = value;
      expect(isMockEnabled()).toBe(true);
    }
    for (const value of ["0", "false", "no", "", "off"]) {
      process.env.DASHBOARD_MOCK_DATA = value;
      expect(isMockEnabled()).toBe(false);
    }
    delete process.env.DASHBOARD_MOCK_DATA;
    expect(isMockEnabled()).toBe(false);
    restore();
  });
});

describe("mock monitoring", () => {
  test("keeps series bounded and deterministic for every range", () => {
    const expectedPoints = { "1h": 61, "6h": 73, "24h": 97, "7d": 169 } as const;
    for (const range of ["1h", "6h", "24h", "7d"] as const) {
      const data = mockGroupMonitoring("skywars-solo", range, now);
      expect(data?.variants[0]?.startup).toHaveLength(expectedPoints[range]);
      expect(data?.variants[0]?.tps).toHaveLength(expectedPoints[range]);
    }
  });

  test("provides compact overview alerts", () => {
    expect(mockMonitoringSummary(now).alerts.map((alert) => alert.metric)).toEqual([
      "TPS_5M",
      "STARTUP_BOOT_60M",
    ]);
  });
});

describe("mock operational incidents", () => {
  test("keeps operational diagnoses separate from performance alerts", () => {
    const incidents = mockIncidents(now);
    expect(incidents.activeCount).toBe(2);
    expect(incidents.criticalCount).toBe(1);
    expect(incidents.incidents.map((incident) => incident.kind)).toEqual([
      "CAPACITY_BLOCKED",
      "HOST_RECOVERY_STUCK",
    ]);
    expect(mockMonitoringSummary(now).alerts).toHaveLength(2);
  });
});

describe("mockCluster", () => {
  test("is stable for a given instant", () => {
    expect(mockCluster(now)).toEqual(mockCluster(now));
  });

  test("keeps identifiers stable as time advances", () => {
    const first = mockCluster(now);
    const later = mockCluster(now + 60_000);
    expect(later.groups.map((group) => group.id)).toEqual(
      first.groups.map((group) => group.id),
    );
    expect(later.groups[1].instances.map((instance) => instance.id)).toEqual(
      first.groups[1].instances.map((instance) => instance.id),
    );
    expect(Date.parse(later.generatedAt)).toBeGreaterThan(
      Date.parse(first.generatedAt),
    );
  });

  test("emits identifiers the API routes accept", () => {
    const snapshot = mockCluster(now);
    for (const group of snapshot.groups) {
      expect(group.id).toMatch(/^[a-z0-9][a-z0-9-]{1,62}$/);
      for (const instance of group.instances) {
        expect(instance.id).toMatch(internalIdPattern);
      }
      for (const session of group.sessions) {
        expect(session.id).toMatch(internalIdPattern);
      }
    }
  });

  test("summary agrees with the groups it summarises", () => {
    const snapshot = mockCluster(now);
    const players = snapshot.groups.reduce(
      (total, group) =>
        total +
        group.instances.reduce(
          (groupTotal, instance) => groupTotal + instance.playerCount,
          0,
        ),
      0,
    );
    const queuedPlayers = snapshot.groups.reduce(
      (total, group) => total + group.queue.playerCount,
      0,
    );
    expect(snapshot.summary.playersOnline).toBe(players);
    expect(snapshot.summary.queuedPlayers).toBe(queuedPlayers);
    expect(snapshot.summary.enabledGroups).toBe(
      snapshot.groups.filter((group) => group.enabled).length,
    );
  });

  test("never overbooks an instance", () => {
    for (const group of mockCluster(now).groups) {
      for (const instance of group.instances) {
        expect(instance.playerCount).toBeLessThanOrEqual(instance.maximumPlayers);
      }
    }
  });

  test("keeps session and transfer player counts coherent", () => {
    for (const group of mockCluster(now).groups) {
      for (const session of group.sessions) {
        expect(session.activePlayerCount).toBeLessThanOrEqual(
          session.maximumPlayerCount,
        );
        expect(session.connectedPlayerCount).toBeLessThanOrEqual(
          session.activePlayerCount,
        );
      }
    }
  });

  test("covers degraded states so the UI can be exercised", () => {
    const states = new Set(
      mockCluster(now).groups.flatMap((group) =>
        group.instances.map((instance) => instance.lifecycleState),
      ),
    );
    expect(states.has("RUNNING")).toBe(true);
    expect(states.has("FAILED")).toBe(true);
    expect(states.has("DRAINING")).toBe(true);
    expect(mockCluster(now).groups.flatMap((group) => group.variants)
      .some((variant) => variant.startup?.state === "BLOCKED")).toBe(true);
  });
});

describe("mockQueue", () => {
  test("returns parties ordered oldest first", () => {
    const detail = mockQueue("skywars-solo", 200, now);
    expect(detail).not.toBeNull();
    const joined = detail!.entries.map((entry) => Date.parse(entry.joinedAt));
    expect(joined).toEqual([...joined].sort((left, right) => left - right));
  });

  test("reports totals independently of the limit", () => {
    const full = mockQueue("skywars-solo", 200, now)!;
    const limited = mockQueue("skywars-solo", 3, now)!;
    expect(limited.entries).toHaveLength(3);
    expect(limited.totalParties).toBe(full.totalParties);
    expect(limited.totalPlayers).toBe(full.totalPlayers);
    expect(limited.truncated).toBe(true);
    expect(full.truncated).toBe(false);
  });

  test("agrees with the queue counters in the cluster snapshot", () => {
    const group = mockCluster(now).groups.find(
      (candidate) => candidate.id === "skywars-solo",
    )!;
    const detail = mockQueue("skywars-solo", 200, now)!;
    expect(detail.totalParties).toBe(group.queue.partyCount);
    expect(detail.totalPlayers).toBe(group.queue.playerCount);
    expect(detail.entries[0]?.joinedAt ?? null).toBe(
      group.queue.oldestJoinedAt as string,
    );
  });

  test("is null for an unknown group", () => {
    expect(mockQueue("does-not-exist", 50, now)).toBeNull();
  });
});

describe("mockInstance and mockSession", () => {
  test("resolve every id advertised by the snapshot", () => {
    const snapshot = mockCluster(now);
    for (const group of snapshot.groups) {
      for (const instance of group.instances) {
        const detail = mockInstance(instance.id, now);
        expect(detail).not.toBeNull();
        expect(detail!.instance.id).toBe(instance.id);
        expect(detail!.instance.groupId).toBe(group.id);
        expect(detail!.players).toHaveLength(instance.playerCount);
      }
      for (const session of group.sessions) {
        const detail = mockSession(session.id, now);
        expect(detail).not.toBeNull();
        expect(detail!.session.id).toBe(session.id);
        expect(detail!.session.groupId).toBe(group.id);
      }
    }
  });

  test("session tickets add up to the active player count", () => {
    const snapshot = mockCluster(now);
    for (const group of snapshot.groups) {
      for (const session of group.sessions) {
        const detail = mockSession(session.id, now)!;
        const players = detail.tickets.reduce(
          (total, ticket) => total + ticket.players.length,
          0,
        );
        expect(players).toBe(session.activePlayerCount);
        const connected = detail.tickets.reduce(
          (total, ticket) =>
            total +
            ticket.players.filter((player) => player.state === "CONNECTED").length,
          0,
        );
        expect(connected).toBe(session.connectedPlayerCount);
      }
    }
  });

  test("cover every active deadline rendered by the timeline", () => {
    const kinds = new Set<string>();
    for (const group of mockCluster(now).groups) {
      for (const instance of group.instances) {
        const deadline = mockInstance(instance.id, now)?.activeDeadline;
        if (deadline) kinds.add(deadline.kind);
      }
      for (const session of group.sessions) {
        const deadline = mockSession(session.id, now)?.activeDeadline;
        if (deadline) kinds.add(deadline.kind);
      }
    }
    expect(kinds).toEqual(new Set([
      "INSTANCE_RENEWAL",
      "INSTANCE_STARTUP",
      "INSTANCE_DRAIN",
      "CANCELLED_INSTANCE_DRAIN",
      "INSTANCE_SHUTDOWN",
      "INSTANCE_ACQUISITION",
      "PLAYER_TRANSFER",
      "LOBBY_STALE",
    ]));
  });

  test("are null for unknown ids", () => {
    expect(mockInstance("0000000000000000", now)).toBeNull();
    expect(mockSession("0000000000000000", now)).toBeNull();
  });
});
