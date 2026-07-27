import { describe, expect, test } from "bun:test";
import { parseDuration, parseGroup, parseVariant } from "../../src/configuration/sync.ts";
import { jsonParameter } from "../../src/db/json.ts";

describe("configuration", () => {
  test("parses duration units", () => {
    expect(parseDuration("45s", "test")).toBe(45_000);
    expect(parseDuration("15m", "test")).toBe(900_000);
  });

  test("validates a minigame group", () => {
    const group = parseGroup(
      {
        id: "skywars-solo",
        type: "minigame",
        enabled: true,
        matchmaking: {
          minimum_players: 4,
          maximum_players: 12,
          team_count: 12,
          team_size: 1,
          waiting_timeout: "45s",
        },
        capacity: {
          minimum_instances: 0,
          maximum_instances: 20,
          minimum_warm_instances: 2,
          maximum_warm_instances: 4,
        },
        lifecycle: {
          startup_timeout: "90s",
          draining_timeout: "15m",
          shutdown_timeout: "20s",
        },
      },
      "group.yml",
    );
    expect(group.matchmaking?.maximumPlayers).toBe(12);
  });

  test("rejects latest images", () => {
    expect(() =>
      parseVariant(
        {
          id: "map",
          group: "group",
          revision: 1,
          weight: 100,
          docker: { image: "itzg/minecraft-server:latest", memory: "4G", cpu: 2 },
          environment: {},
        },
        "variant.yml",
      ),
    ).toThrow();
  });

  test("serializes JSONB values before binding them", () => {
    const serialized = jsonParameter({
      image: "itzg/minecraft-server:java25",
      memoryBytes: 4_294_967_296,
      cpu: 2,
      environment: { EULA: "TRUE" },
    });
    expect(typeof serialized).toBe("string");
    expect(JSON.parse(serialized).environment.EULA).toBe("TRUE");
  });
});
