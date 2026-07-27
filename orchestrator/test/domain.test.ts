import { describe, expect, test } from "bun:test";
import { decideCapacity } from "../src/domain/capacity.ts";
import { packParties } from "../src/domain/matchmaking.ts";
import { shouldRetryFailedSession } from "../src/domain/session-recovery.ts";
import {
  assertAvailabilityTransition,
  assertLifecycleTransition,
  isWarmPending,
} from "../src/domain/state-machines.ts";
import { selectVariant } from "../src/domain/variant-selection.ts";

describe("state machines", () => {
  test("accepts valid lifecycle transitions and rejects invalid ones", () => {
    expect(() => assertLifecycleTransition("STARTING", "RUNNING")).not.toThrow();
    expect(() => assertLifecycleTransition("RUNNING", "CREATING")).toThrow();
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
    const decision = decideCapacity(
      {
        minimumInstances: 0,
        maximumInstances: 10,
        minimumWarmInstances: 2,
        maximumWarmInstances: 4,
      },
      instances,
    );
    expect(decision.create).toBe(0);
  });
});

describe("matchmaking", () => {
  test("keeps parties atomic and fills teams first-fit", () => {
    const now = Date.now();
    const result = packParties(
      [
        { entryId: "a", partyId: "a", playerIds: ["1", "2", "3"], joinedAt: new Date(now) },
        { entryId: "b", partyId: "b", playerIds: ["4"], joinedAt: new Date(now + 1) },
        { entryId: "c", partyId: "c", playerIds: ["5", "6"], joinedAt: new Date(now + 2) },
        { entryId: "d", partyId: "d", playerIds: ["7", "8"], joinedAt: new Date(now + 3) },
      ],
      2,
      4,
    );
    expect(result.teams[0]?.playerIds).toEqual(["1", "2", "3", "4"]);
    expect(result.teams[1]?.playerIds).toEqual(["5", "6", "7", "8"]);
  });

  test("leaves an oversized backfill party available for a later session", () => {
    const party = {
      entryId: "party",
      partyId: "party",
      playerIds: ["4", "5"],
      joinedAt: new Date(),
    };
    const firstSession = packParties(
      [party],
      2,
      4,
      8,
      [
        {
          teamIndex: 0,
          parties: [],
          playerIds: ["a", "b", "c"],
        },
        {
          teamIndex: 1,
          parties: [],
          playerIds: ["d", "e", "f"],
        },
      ],
    );
    expect(firstSession.selected).toHaveLength(0);

    const laterSession = packParties([party], 2, 4, 8);
    expect(laterSession.selected.map((selected) => selected.entryId)).toEqual(["party"]);
  });
});

describe("variant selection", () => {
  test("prefers the least represented weighted variant", () => {
    const selected = selectVariant([
      { id: "japan", weight: 100, warmCount: 2 },
      { id: "mayas", weight: 100, warmCount: 0 },
    ]);
    expect(selected.id).toBe("mayas");
  });
});

describe("session failure recovery", () => {
  test("allows a bounded retry only before a game starts and before any arrival", () => {
    expect(shouldRetryFailedSession("TRANSFERRING", 0, 0, 2)).toBeTrue();
    expect(shouldRetryFailedSession("WAITING", 0, 1, 2)).toBeTrue();
    expect(shouldRetryFailedSession("TRANSFERRING", 1, 0, 2)).toBeFalse();
    expect(shouldRetryFailedSession("STARTING", 0, 0, 2)).toBeFalse();
    expect(shouldRetryFailedSession("RUNNING", 0, 0, 2)).toBeFalse();
    expect(shouldRetryFailedSession("TRANSFERRING", 0, 2, 2)).toBeFalse();
  });
});
