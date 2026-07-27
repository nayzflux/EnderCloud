import { describe, expect, test } from "bun:test";
import { decideCapacity } from "../../src/domain/capacity.ts";
import { packParties } from "../../src/domain/matchmaking.ts";
import { shouldRetryFailedSession } from "../../src/domain/session-recovery.ts";
import {
  assertAvailabilityTransition,
  assertLifecycleTransition,
  isWarmPending,
} from "../../src/domain/state-machines.ts";
import { selectVariant } from "../../src/domain/variant-selection.ts";

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

describe("matchmaking (packParties)", () => {
  const now = Date.now();

  test("1.1 Atomicité: garde les groupes unis et ignore les groupes trop grands", () => {
    const result = packParties(
      [
        { entryId: "a", partyId: "a", playerIds: ["1", "2", "3"], joinedAt: new Date(now) },
        { entryId: "b", partyId: "b", playerIds: ["4", "5", "6", "7", "8"], joinedAt: new Date(now) },
      ],
      2,
      4,
    );
    // Le groupe "a" (3 joueurs) entre dans la première équipe.
    expect(result.teams[0]?.playerIds).toEqual(["1", "2", "3"]);
    // Le groupe "b" (5 joueurs) dépasse la taille d'équipe (4) et est ignoré.
    expect(result.selected.map(s => s.entryId)).toEqual(["a"]);
  });

  test("1.2 Priorité FIFO: respecte l'ordre d'arrivée dans la file", () => {
    const result = packParties(
      [
        { entryId: "g3", partyId: "g3", playerIds: ["5", "6"], joinedAt: new Date(now + 2) },
        { entryId: "g1", partyId: "g1", playerIds: ["1", "2"], joinedAt: new Date(now) },
        { entryId: "g2", partyId: "g2", playerIds: ["3", "4"], joinedAt: new Date(now + 1) },
      ],
      2,
      4,
      4, // maximumPlayers = 4
    );
    // G1 et G2 sont sélectionnés car ils sont arrivés en premier (G1 à now, G2 à now+1).
    expect(result.selected.map(s => s.entryId)).toEqual(["g1", "g2"]);
    expect(result.teams[0]?.playerIds).toEqual(["1", "2", "3", "4"]);
  });

  test("1.3 First-Fit: remplit la première équipe disponible avant de passer à la suivante", () => {
    const result = packParties(
      [
        { entryId: "g1", partyId: "g1", playerIds: ["3", "4"], joinedAt: new Date(now) },
      ],
      2,
      4,
      8,
      [
        { teamIndex: 0, parties: [], playerIds: ["1", "2"] }, // Reste 2 places
        { teamIndex: 1, parties: [], playerIds: [] },         // Reste 4 places
      ]
    );
    // g1 doit être placé dans l'équipe 0 car il y a de la place (2 joueurs existants + 2 nouveaux = 4)
    expect(result.teams[0]?.playerIds).toEqual(["1", "2", "3", "4"]);
    expect(result.teams[1]?.playerIds).toEqual([]);
  });

  test("1.4 Limite Globale: ne dépasse pas maximumPlayers même s'il y a de la place dans une équipe", () => {
    const result = packParties(
      [
        { entryId: "new", partyId: "new", playerIds: ["5", "6"], joinedAt: new Date(now) },
      ],
      2,
      4,
      6, // maximumPlayers = 6
      [
        { teamIndex: 0, parties: [], playerIds: ["1", "2", "3"] }, // Reste 1 place
        { teamIndex: 1, parties: [], playerIds: ["4", "5"] },      // Reste 2 places (physiquement possible pour 'new')
      ]
    );
    // Total actuel: 5. Groupe 'new': 2. Total attendu: 7 > maximumPlayers (6).
    // Donc le groupe 'new' ne doit pas être sélectionné.
    expect(result.selected).toHaveLength(0);
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
