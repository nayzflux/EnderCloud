import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfiguration, parseDuration, parseGroup, parseVariant } from "../../src/configuration/sync.ts";
import { jsonParameter } from "../../src/db/json.ts";

describe("configuration", () => {
  test("parses duration units", () => {
    expect(parseDuration("45s", "test")).toBe(45_000);
    expect(parseDuration("15m", "test")).toBe(900_000);
  });

  test("defaults and validates the hub instance lifetime", () => {
    const base = {
      id: "hub",
      type: "hub",
      variants: [{ id: "hub-main", enabled: true, weight: 100 }],
      capacity: {
        minimum_instances: 1,
        maximum_instances: 3,
        minimum_warm_instances: 1,
        maximum_warm_instances: 2,
      },
      routing: {
        maximum_players_per_instance: 100,
        target_players_per_instance: 70,
      },
      timeouts: {
        startup: "90s",
        drain: "5m",
        cancelled_drain: "10s",
        shutdown: "20s",
        transfer: "20s",
        player_stale: "30s",
      },
    } as const;
    expect(parseGroup(base, "hub.yml").timeouts.instanceLifetimeMs).toBe(14_400_000);
    expect(parseGroup({
      ...base,
      timeouts: { ...base.timeouts, instance_lifetime: "6h" },
    }, "hub.yml").timeouts.instanceLifetimeMs).toBe(21_600_000);
    expect(() => parseGroup({
      ...base,
      type: "minigame",
      matchmaking: {
        minimum_players: 2,
        maximum_players: 4,
        team_count: 2,
        team_size: 2,
      },
      timeouts: {
        ...base.timeouts,
        instance_lifetime: "4h",
        instance_acquisition: "45s",
        lobby_stale: "135s",
      },
    }, "minigame.yml")).toThrow("only valid for hub groups");
  });

  test("validates a minigame group", () => {
    const group = parseGroup(
      {
        id: "skywars-solo",
        type: "minigame",
        enabled: true,
        variants: [{ id: "skywars-map", enabled: true, weight: 100 }],
        matchmaking: {
          minimum_players: 4,
          maximum_players: 12,
          team_count: 12,
          team_size: 1,
          team_balance: {
            minimum_players_per_team: 0,
            maximum_team_spread: 1,
          },
        },
        capacity: {
          minimum_instances: 0,
          maximum_instances: 20,
          minimum_warm_instances: 2,
          maximum_warm_instances: 4,
        },
        timeouts: {
          startup: "90s",
          drain: "15m",
          cancelled_drain: "10s",
          shutdown: "20s",
          transfer: "20s",
          player_stale: "30s",
          instance_acquisition: "45s",
          lobby_stale: "135s",
        },
      },
      "group.yml",
    );
    expect(group.matchmaking?.maximumPlayers).toBe(12);
    expect(group.matchmaking).toMatchObject({
      candidateWindow: 20,
      minimumPlayersPerTeam: 0,
      maximumTeamSpread: 1,
    });
    expect(group.timeouts).toMatchObject({
      transferMs: 20_000,
      instanceAcquisitionMs: 45_000,
      lobbyStaleMs: 135_000,
    });
  });

  test("parses the legacy team-balancing policy alias", () => {
    const group = parseGroup(
      {
        id: "bedwars-4v4v4v4",
        type: "minigame",
        variants: [{ id: "bedwars-map", enabled: true, weight: 100 }],
        matchmaking: {
          minimum_players: 8,
          maximum_players: 16,
          team_count: 4,
          team_size: 4,
          waiting_timeout: "60s",
          instance_wait_timeout: "30s",
          maximum_waiting_timeout: "4m",
          candidate_window: 32,
          partial_start: {
            minimum_players_per_team: 1,
            maximum_team_spread: 2,
          },
        },
        capacity: {
          minimum_instances: 0,
          maximum_instances: 20,
          minimum_warm_instances: 0,
          maximum_warm_instances: 4,
        },
        lifecycle: {
          startup_timeout: "90s",
          draining_timeout: "15m",
          shutdown_timeout: "20s",
        },
      },
      "bedwars.yml",
    );
    expect(group.matchmaking).toMatchObject({
      candidateWindow: 32,
      minimumPlayersPerTeam: 1,
      maximumTeamSpread: 2,
    });
    expect(group.timeouts).toMatchObject({
      instanceAcquisitionMs: 30_000,
      lobbyStaleMs: 240_000,
    });
  });

  test("warns on legacy aliases and rejects duplicate timeout names", () => {
    const warnings: string[] = [];
    const legacy = {
      id: "legacy-hub",
      type: "hub",
      variants: [{ id: "legacy-map", enabled: true, weight: 100 }],
      capacity: {
        minimum_instances: 0,
        maximum_instances: 2,
        minimum_warm_instances: 0,
        maximum_warm_instances: 1,
      },
      routing: {
        maximum_players_per_instance: 100,
        target_players_per_instance: 70,
      },
      lifecycle: {
        startup_timeout: "90s",
        draining_timeout: "5m",
        shutdown_timeout: "20s",
      },
    };
    parseGroup(legacy, "legacy.yml", {
      transferMs: 20_000,
      cancelledDrainMs: 10_000,
      warn: (message) => warnings.push(message),
    });
    expect(warnings.length).toBe(3);
    expect(() =>
      parseGroup(
        {
          ...legacy,
          timeouts: { startup: "90s" },
        },
        "duplicate.yml",
      )
    ).toThrow("cannot define both");
  });

  test("rejects non-positive durations and duplicate lobby-stale aliases", () => {
    expect(() => parseDuration("0s", "timeout")).toThrow("greater than zero");
    expect(() => parseDuration(-1, "timeout")).toThrow("duration");

    expect(() =>
      parseGroup(
        {
          id: "invalid-minigame",
          type: "minigame",
          variants: [{ id: "invalid-map", enabled: true, weight: 100 }],
          capacity: {
            minimum_instances: 0,
            maximum_instances: 2,
            minimum_warm_instances: 0,
            maximum_warm_instances: 1,
          },
          matchmaking: {
            minimum_players: 2,
            maximum_players: 4,
            team_count: 2,
            team_size: 2,
          },
          timeouts: {
            startup: "90s",
            drain: "5m",
            cancelled_drain: "10s",
            shutdown: "20s",
            transfer: "20s",
            player_stale: "30s",
            instance_acquisition: "45s",
            lobby_stale: "135s",
            ineligible_lobby: "135s",
          },
        },
        "invalid.yml",
      )
    ).toThrow("duplicate timeout names");
  });

  test("rejects latest images", () => {
    expect(() =>
      parseVariant(
        {
          id: "map",
          revision: 1,
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

  test("resolves ordered layers and propagates parent checksums", async () => {
    const root = await mkdtemp(join(tmpdir(), "endercloud-layers-"));
    const groups = join(root, "groups");
    const templates = join(root, "templates");
    try {
      await mkdir(groups);
      await mkdir(templates);
      await writeFile(join(groups, "skywars.yml"), `
id: skywars-solo
type: hub
enabled: true
variants:
  - id: map-one
    enabled: true
    weight: 60
capacity:
  minimum_instances: 0
  maximum_instances: 2
  minimum_warm_instances: 0
  maximum_warm_instances: 1
routing:
  maximum_players_per_instance: 12
  target_players_per_instance: 10
timeouts:
  startup: 90s
  drain: 5m
  cancelled_drain: 10s
  shutdown: 20s
  transfer: 20s
  player_stale: 30s
`);
      for (const id of ["skywars", "skywars-solo", "map-one"]) {
        await mkdir(join(templates, id));
      }
      await writeFile(join(templates, "skywars", "variant.yml"), `
id: skywars
docker:
  image: itzg/minecraft-server:java25
  memory: 2G
  cpu: 2
environment:
  MODE: base
`);
      await mkdir(join(templates, "skywars", "plugins"));
      await writeFile(join(templates, "skywars", "plugins", "common.jar"), "v1");
      await writeFile(join(templates, "skywars-solo", "variant.yml"), `
id: skywars-solo
environment:
  MODE: solo
`);
      await writeFile(join(templates, "map-one", "variant.yml"), `
id: map-one
revision: 3
parents: [skywars, skywars-solo]
environment:
  MAP_ID: one
`);

      const first = await loadConfiguration(groups, templates);
      expect(first.variants[0]?.layers.map((layer) => layer.id)).toEqual([
        "skywars",
        "skywars-solo",
        "map-one",
      ]);
      expect(first.variants[0]?.runtime).toMatchObject({
        image: "itzg/minecraft-server:java25",
        memoryBytes: 2 * 1024 ** 3,
        cpu: 2,
        environment: { MODE: "solo", MAP_ID: "one" },
      });
      const checksum = first.variants[0]?.checksum;
      await writeFile(join(templates, "skywars", "plugins", "common.jar"), "v2");
      const second = await loadConfiguration(groups, templates);
      expect(second.variants[0]?.checksum).not.toBe(checksum);
      await writeFile(join(templates, "skywars-solo", "variant.yml"), `
id: skywars-solo
parents: [skywars]
`);
      await expect(loadConfiguration(groups, templates)).rejects.toThrow(
        "cannot declare parents",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects legacy ownership fields", () => {
    expect(() => parseVariant({ id: "legacy", group: "skywars" }, "variant.yml"))
      .toThrow("no longer valid");
  });
});
