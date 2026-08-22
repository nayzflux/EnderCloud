import { describe, expect, test } from "bun:test";
import { decideCapacity } from "../../src/domain/capacity.ts";
import {
  computeFeasibleProfiles,
  isSessionLockEligible,
  rankSessionCandidates,
  selectRecommendedProfile,
} from "../../src/domain/matchmaking.ts";
import {
  assertAvailabilityTransition,
  assertLifecycleTransition,
  assertSessionTransition,
  isWarmPending,
} from "../../src/domain/state-machines.ts";
import { selectVariant } from "../../src/domain/variant-selection.ts";
import { allocateHubPlayers } from "../../src/domain/hub-routing.ts";

describe("state machines", () => {
  test("accepts valid lifecycle transitions and rejects invalid ones", () => {
    expect(() => assertLifecycleTransition("STARTING", "RUNNING")).not.toThrow();
    expect(() => assertLifecycleTransition("RUNNING", "CREATING")).toThrow();
    expect(() => assertSessionTransition("STARTING", "CANCELLED")).not.toThrow();
    expect(() => assertSessionTransition("RUNNING", "CANCELLED")).not.toThrow();
  });

  test("reservation is irreversible", () => {
    expect(() => assertAvailabilityTransition("OPEN", "RESERVED")).not.toThrow();
    expect(() => assertAvailabilityTransition("RESERVED", "OPEN")).toThrow();
  });

  test("pending warm capacity includes creating and starting only", () => {
    expect(isWarmPending("CREATING", "OPEN")).toBeTrue();
    expect(isWarmPending("STARTING", "OPEN")).toBeTrue();
    expect(isWarmPending("DRAINING", "OPEN")).toBeFalse();
  });

  test("reopens an instance-waiting session after a pre-transfer ticket cancellation", () => {
    expect(() => assertSessionTransition("WAITING_FOR_INSTANCE", "FORMING")).not.toThrow();
  });
});

describe("capacity", () => {
  test("does not over-create when pending instances fill the warm target", () => {
    const decision = decideCapacity(
      {
        minimumInstances: 0,
        maximumInstances: 10,
        minimumWarmInstances: 3,
        maximumWarmInstances: 4,
      },
      [
        { lifecycle: "RUNNING", availability: "OPEN" },
        { lifecycle: "CREATING", availability: "OPEN" },
        { lifecycle: "STARTING", availability: "OPEN" },
      ],
    );
    expect(decision.create).toBe(0);
  });

  test("honours the absolute maximum", () => {
    const instances = Array.from({ length: 10 }, () => ({
      lifecycle: "RUNNING" as const,
      availability: "RESERVED" as const,
    }));
    expect(decideCapacity(
      {
        minimumInstances: 0,
        maximumInstances: 10,
        minimumWarmInstances: 2,
        maximumWarmInstances: 4,
      },
      instances,
    ).create).toBe(0);
  });

  test("scales at the aggregate hub target and counts pending instances", () => {
    const policy = {
      minimumInstances: 1,
      maximumInstances: 5,
      minimumWarmInstances: 1,
      maximumWarmInstances: 4,
    };
    const running = [{ lifecycle: "RUNNING" as const, availability: "OPEN" as const }];
    expect(decideCapacity(policy, running, true, 1).create).toBe(0);
    expect(decideCapacity(policy, running, true, 2).create).toBe(1);
    expect(decideCapacity(
      policy,
      [...running, { lifecycle: "STARTING", availability: "OPEN" }],
      true,
      2,
    ).create).toBe(0);
  });
});

describe("hub routing", () => {
  test("balances a batch using effective load and keeps the target soft", () => {
    const players = ["one", "two", "three", "four", "five"];
    const decision = allocateHubPlayers(players, [
      { id: "over-target", effectiveLoad: 75, maximumPlayers: 100 },
      { id: "reserved", effectiveLoad: 11, maximumPlayers: 100 },
      { id: "least", effectiveLoad: 10, maximumPlayers: 100 },
    ]);
    expect(decision.assignments).toEqual([
      { targetId: "least", playerIds: ["one", "two", "four"] },
      { targetId: "reserved", playerIds: ["three", "five"] },
    ]);
    expect(decision.rejectedPlayers).toEqual([]);
  });

  test("never allocates beyond the strict maximum", () => {
    const decision = allocateHubPlayers(["one", "two", "three"], [
      { id: "almost-full", effectiveLoad: 99, maximumPlayers: 100 },
      { id: "full", effectiveLoad: 100, maximumPlayers: 100 },
    ]);
    expect(decision.assignments).toEqual([
      { targetId: "almost-full", playerIds: ["one"] },
    ]);
    expect(decision.rejectedPlayers).toEqual(["two", "three"]);
  });
});

describe("matchmaking profiles", () => {
  test("recommends the required balanced composition", () => {
    const profiles = computeFeasibleProfiles([3, 2, 1, 1, 1], 4, 4);
    expect(selectRecommendedProfile(profiles)).toEqual([1, 2, 2, 3]);
  });

  test("finds an exact full composition", () => {
    const profiles = computeFeasibleProfiles([4, 3, 2, 2, 1, 1, 1, 1, 1], 4, 4);
    expect(profiles).toContainEqual([4, 4, 4, 4]);
  });

  test("rejects impossible atomic tickets and aggregate compositions", () => {
    expect(computeFeasibleProfiles([5], 4, 4)).toEqual([]);
    expect(computeFeasibleProfiles([3, 3, 3, 3, 2, 2], 4, 4)).toEqual([]);
    expect(computeFeasibleProfiles([4, 4, 3, 3, 3], 4, 4)).toEqual([]);
  });

  test("prefers completing the 14-player session with a ticket of two", () => {
    const ranked = rankSessionCandidates(
      [
        { sessionId: "eight", createdAt: new Date(0), ticketSizes: [2, 2, 2, 2] },
        { sessionId: "fourteen", createdAt: new Date(1), ticketSizes: [4, 4, 4, 2] },
      ],
      2,
      4,
      4,
      16,
    );
    expect(ranked[0]?.sessionId).toBe("fourteen");
    expect(ranked[0]?.recommendedProfile).toEqual([4, 4, 4, 4]);
  });

  test("skips an incompatible older session for a compatible later one", () => {
    const ranked = rankSessionCandidates(
      [
        { sessionId: "blocked", createdAt: new Date(0), ticketSizes: [4, 4, 3, 3] },
        { sessionId: "open", createdAt: new Date(1), ticketSizes: [3, 2, 1, 1, 1] },
      ],
      3,
      4,
      4,
      16,
    );
    expect(ranked.map((candidate) => candidate.sessionId)).not.toContain("blocked");
    expect(ranked[0]?.sessionId).toBe("open");
  });

  test("reports whether a connected profile matches the advisory team policy", () => {
    expect(isSessionLockEligible(8, 8, 16, [1, 2, 2, 3], 1, 2)).toBeTrue();
    expect(isSessionLockEligible(8, 8, 16, [0, 0, 4, 4], 1, 2)).toBeFalse();
    expect(isSessionLockEligible(16, 8, 16, [4, 4, 4, 4], 1, 2)).toBeTrue();
    expect(isSessionLockEligible(16, 8, 16, null, 1, 2)).toBeFalse();
  });
});

describe("variant selection", () => {
  test("prefers the least represented weighted variant", () => {
    expect(selectVariant([
      { id: "japan", weight: 100, warmCount: 2 },
      { id: "mayas", weight: 100, warmCount: 0 },
    ]).id).toBe("mayas");
  });
});
