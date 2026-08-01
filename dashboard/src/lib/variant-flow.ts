import type { Edge, MarkerType, Node } from "@xyflow/react";
import type { DashboardVariantGraph } from "./contracts";

export interface VariantFlowNodeData extends Record<string, unknown> {
  readonly kind: "layer" | "final";
  readonly layer: DashboardVariantGraph["layers"][number];
  readonly variant?: DashboardVariantGraph["variants"][number];
  readonly percentage?: number;
  readonly depth: number;
  readonly onSelect?: () => void;
}

export type VariantFlowNode = Node<VariantFlowNodeData, "variantLayer">;

export interface VariantFlowModel {
  readonly nodes: readonly VariantFlowNode[];
  readonly edges: readonly Edge[];
}

interface TrieNode {
  readonly key: string;
  readonly layerId: string;
  readonly depth: number;
  readonly children: Map<string, TrieNode>;
  variant?: DashboardVariantGraph["variants"][number];
  branchWeight: number;
  y: number;
}

const NODE_WIDTH = 232;
const NODE_HEIGHT = 112;
const COLUMN_GAP = 88;
const ROW_GAP = 54;

function nodeKey(path: readonly string[]): string {
  return `layer:${path.join("::")}`;
}

export function buildVariantFlow(
  graph: DashboardVariantGraph,
  options: { readonly search: string; readonly enabledOnly: boolean },
): VariantFlowModel {
  const search = options.search.trim().toLowerCase();
  const layers = new Map(graph.layers.map((layer) => [layer.id, layer]));
  const enabledWeight = graph.variants.reduce(
    (total, variant) => total + (variant.enabled ? variant.weight : 0),
    0,
  );
  const visibleVariants = graph.variants.filter((variant) => {
    if (options.enabledOnly && !variant.enabled) return false;
    if (!search) return true;
    return [variant.id, ...variant.layers].some((value) =>
      value.toLowerCase().includes(search),
    );
  });

  const roots = new Map<string, TrieNode>();
  for (const variant of visibleVariants) {
    let siblings = roots;
    const path: string[] = [];
    let current: TrieNode | undefined;
    for (const [depth, layerId] of variant.layers.entries()) {
      path.push(layerId);
      current = siblings.get(layerId);
      if (!current) {
        current = {
          key: nodeKey(path),
          layerId,
          depth,
          children: new Map(),
          branchWeight: 0,
          y: 0,
        };
        siblings.set(layerId, current);
      }
      current.branchWeight += variant.enabled ? variant.weight : 0;
      siblings = current.children;
    }
    if (current) current.variant = variant;
  }

  let leafIndex = 0;
  function position(node: TrieNode): number {
    if (node.children.size === 0) {
      node.y = leafIndex * (NODE_HEIGHT + ROW_GAP);
      leafIndex += 1;
      return node.y;
    }
    const childYs = [...node.children.values()].map(position);
    node.y = (childYs[0]! + childYs.at(-1)!) / 2;
    return node.y;
  }
  for (const root of roots.values()) position(root);

  const nodes: VariantFlowNode[] = [];
  const edges: Edge[] = [];
  function visit(node: TrieNode, parent?: TrieNode): void {
    const layer = layers.get(node.layerId);
    if (!layer) return;
    const variant = node.variant;
    nodes.push({
      id: node.key,
      type: "variantLayer",
      position: {
        x: node.depth * (NODE_WIDTH + COLUMN_GAP),
        y: node.y,
      },
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      data: {
        kind: variant ? "final" : "layer",
        layer,
        ...(variant ? { variant } : {}),
        ...(variant && enabledWeight > 0
          ? { percentage: (variant.enabled ? variant.weight : 0) / enabledWeight }
          : {}),
        depth: node.depth,
      },
      style: { width: NODE_WIDTH, height: NODE_HEIGHT },
      draggable: false,
    });
    if (parent) {
      const share = enabledWeight > 0 ? node.branchWeight / enabledWeight : 0;
      edges.push({
        id: `${parent.key}->${node.key}`,
        source: parent.key,
        target: node.key,
        sourceHandle: "out",
        targetHandle: "in",
        type: "smoothstep",
        selectable: false,
        focusable: false,
        markerEnd: {
          type: "arrowclosed" as MarkerType,
          width: 11,
          height: 11,
          color: "var(--muted-foreground)",
        },
        style: {
          stroke: "var(--muted-foreground)",
          strokeWidth: 1.5 + share * 3,
        },
      });
    }
    for (const child of node.children.values()) visit(child, node);
  }
  for (const root of roots.values()) visit(root);
  return { nodes, edges };
}
