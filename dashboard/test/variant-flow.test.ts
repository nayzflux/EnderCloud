import { describe, expect, test } from "bun:test";
import type { DashboardVariantGraph } from "../src/lib/contracts";
import { buildVariantFlow } from "../src/lib/variant-flow";

const runtime = {
  image: "itzg/minecraft-server:java25",
  memoryBytes: 2 * 1024 ** 3,
  cpu: 2,
  environment: {},
};

const graph: DashboardVariantGraph = {
  schemaVersion: 1,
  generatedAt: "2026-08-01T12:00:00.000Z",
  groupId: "skywars-solo",
  layers: ["skywars", "skywars-solo", "map-one", "map-two"].map((id) => ({
    id,
    checksum: id.padEnd(64, "0"),
    runtime: { environment: {} },
    files: { fileCount: 1, totalBytes: 10, roots: ["config"] },
  })),
  variants: [
    {
      id: "map-one",
      enabled: true,
      revision: 1,
      weight: 60,
      checksum: "1".repeat(64),
      runtime,
      layers: ["skywars", "skywars-solo", "map-one"],
    },
    {
      id: "map-two",
      enabled: true,
      revision: 1,
      weight: 40,
      checksum: "2".repeat(64),
      runtime,
      layers: ["skywars", "skywars-solo", "map-two"],
    },
  ],
};

describe("buildVariantFlow", () => {
  test("shares common prefixes and branches into weighted final variants", () => {
    const model = buildVariantFlow(graph, { search: "", enabledOnly: true });
    expect(model.nodes.map((node) => node.data.layer.id)).toEqual([
      "skywars",
      "skywars-solo",
      "map-one",
      "map-two",
    ]);
    const finals = model.nodes.filter((node) => node.data.kind === "final");
    expect(finals.map((node) => Math.round((node.data.percentage ?? 0) * 100))).toEqual([60, 40]);
    expect(model.edges).toHaveLength(3);
  });

  test("filters a final while retaining its complete resolved stack", () => {
    const model = buildVariantFlow(graph, { search: "map-two", enabledOnly: true });
    expect(model.nodes.map((node) => node.data.layer.id)).toEqual([
      "skywars",
      "skywars-solo",
      "map-two",
    ]);
  });
});
