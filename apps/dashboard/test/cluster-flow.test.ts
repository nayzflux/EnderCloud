import { describe, expect, test } from "bun:test";
import { buildClusterFlow } from "../src/lib/cluster-flow";
import { snapshot } from "./fixtures";

const noFilters = { groupId: "all", state: "all", search: "" } as const;

function idsOfKind(
  model: ReturnType<typeof buildClusterFlow>,
  kind: string,
): string[] {
  return model.nodes
    .filter((node) => node.data.kind === kind)
    .map((node) => node.id);
}

/** Depth of a node in the queue → pool → instance → session tree. */
const depthOf: Record<string, number> = {
  queue: 0,
  pool: 1,
  instance: 2,
  session: 3,
};

describe("buildClusterFlow", () => {
  test("renders one frame and one pool per group", () => {
    const model = buildClusterFlow(snapshot, noFilters);
    expect(idsOfKind(model, "groupFrame")).toEqual([
      "group:hub",
      "group:skywars-solo",
    ]);
    expect(idsOfKind(model, "pool")).toEqual(["pool:hub", "pool:skywars-solo"]);
  });

  test("only matchmaking groups get a queue node", () => {
    const model = buildClusterFlow(snapshot, noFilters);
    expect(idsOfKind(model, "queue")).toEqual(["queue:skywars-solo"]);
  });

  test("declares a size for every node so edges and the minimap can render", () => {
    const model = buildClusterFlow(snapshot, noFilters);
    for (const node of model.nodes) {
      expect(node.width).toBeGreaterThan(0);
      expect(node.height).toBeGreaterThan(0);
    }
  });

  test("captions the instance row and the waiting area", () => {
    const model = buildClusterFlow(snapshot, noFilters);
    const frame = model.nodes.find((node) => node.id === "group:skywars-solo");
    expect((frame?.data.lanes ?? []).map((lane) => lane.id)).toEqual([
      "instances",
      "waiting",
    ]);
  });

  test("nests children in their group frame and pins them to it", () => {
    const model = buildClusterFlow(snapshot, noFilters);
    const children = model.nodes.filter((node) => node.data.kind !== "groupFrame");
    expect(children.length).toBeGreaterThan(0);
    for (const child of children) {
      expect(child.parentId).toBe(`group:${child.data.group.id}`);
      expect(child.extent).toBe("parent");
    }
  });

  test("stacks groups without overlapping", () => {
    const model = buildClusterFlow(snapshot, noFilters);
    const [first, second] = model.nodes.filter(
      (node) => node.data.kind === "groupFrame",
    );
    const firstBottom = first.position.y + Number(first.height ?? 0);
    expect(second.position.y).toBeGreaterThan(firstBottom);
  });

  test("every edge runs one level down the tree, through the same handles", () => {
    const model = buildClusterFlow(snapshot, noFilters);
    const byId = new Map(model.nodes.map((node) => [node.id, node]));
    expect(model.edges.length).toBeGreaterThan(0);

    for (const edge of model.edges) {
      const source = byId.get(edge.source);
      const target = byId.get(edge.target);
      expect(source).toBeDefined();
      expect(target).toBeDefined();
      expect(edge.sourceHandle).toBe("out");
      expect(edge.targetHandle).toBe("in");
      // Strictly forwards: a link never points back up or sideways.
      expect(depthOf[target!.data.kind]).toBeGreaterThan(
        depthOf[source!.data.kind],
      );
      expect(target!.position.y).toBeGreaterThan(source!.position.y);
    }
  });

  test("never draws two edges between the same pair of nodes", () => {
    const model = buildClusterFlow(snapshot, noFilters);
    const pairs = model.edges.map((edge) => `${edge.source}|${edge.target}`);
    expect(new Set(pairs).size).toBe(pairs.length);
    expect(new Set(model.edges.map((edge) => edge.id)).size).toBe(
      model.edges.length,
    );
  });

  test("wires the whole chain for a matchmaking group", () => {
    const model = buildClusterFlow(snapshot, noFilters);
    const ids = model.edges.map((edge) => edge.id);
    expect(ids).toContain("queue:skywars-solo->pool:skywars-solo");
    expect(ids).toContain("pool:skywars-solo->instance:skywarsrunning01");
    expect(ids).toContain(
      "instance:skywarsrunning01->session:skywarssession01",
    );
  });

  test("dashes only the link to a session still waiting for an instance", () => {
    const model = buildClusterFlow(snapshot, noFilters);
    const dashed = model.edges.filter(
      (edge) => edge.style?.strokeDasharray !== undefined,
    );
    expect(dashed.map((edge) => edge.target)).toEqual([
      "session:skywarssession02",
    ]);
    expect(
      model.nodes.find((node) => node.id === "session:skywarssession02")?.data
        .waiting,
    ).toBe(true);
  });

  test("places a hosted session directly under its instance", () => {
    const model = buildClusterFlow(snapshot, noFilters);
    const instance = model.nodes.find(
      (node) => node.id === "instance:skywarsrunning01",
    );
    const session = model.nodes.find(
      (node) => node.id === "session:skywarssession01",
    );
    expect(session?.position.x).toBe(instance!.position.x);
    expect(session!.position.y).toBeGreaterThan(instance!.position.y);
  });

  test("filters instances by state", () => {
    const model = buildClusterFlow(snapshot, { ...noFilters, state: "attention" });
    expect(idsOfKind(model, "instance")).toEqual(["instance:skywarsfailed001"]);
  });

  test("filters instances by search across id, variant and endpoint", () => {
    const byEndpoint = buildClusterFlow(snapshot, {
      ...noFilters,
      search: "25566",
    });
    expect(idsOfKind(byEndpoint, "instance")).toEqual([
      "instance:skywarsrunning01",
    ]);

    const byVariant = buildClusterFlow(snapshot, {
      ...noFilters,
      search: "hub-aurora",
    });
    expect(idsOfKind(byVariant, "instance")).toEqual(["instance:hubinstance00001"]);
  });

  test("restricts the model to a single group", () => {
    const model = buildClusterFlow(snapshot, { ...noFilters, groupId: "hub" });
    expect(idsOfKind(model, "groupFrame")).toEqual(["group:hub"]);
    expect(idsOfKind(model, "queue")).toEqual([]);
  });

  test("hides a session whose instance was filtered out", () => {
    const model = buildClusterFlow(snapshot, { ...noFilters, state: "attention" });
    expect(idsOfKind(model, "session")).toEqual(["session:skywarssession02"]);
    expect(
      model.edges.some((edge) => edge.target === "session:skywarssession01"),
    ).toBe(false);
  });
});
