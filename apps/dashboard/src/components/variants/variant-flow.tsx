"use client";

import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  type NodeTypes,
} from "@xyflow/react";
import { useMemo } from "react";
import { VariantLayerNode } from "./variant-layer-node";
import type { VariantFlowModel, VariantFlowNode } from "@/lib/variant-flow";
import "@xyflow/react/dist/style.css";

const nodeTypes: NodeTypes = { variantLayer: VariantLayerNode };

export function VariantFlow({
  model,
  onSelect,
  selectedId,
}: {
  readonly model: VariantFlowModel;
  readonly onSelect: (node: VariantFlowNode) => void;
  readonly selectedId?: string;
}) {
  const nodes = useMemo(
    () => model.nodes.map((node) => ({
      ...node,
      selected: node.id === selectedId,
      data: { ...node.data, onSelect: () => onSelect(node) },
    })),
    [model.nodes, onSelect, selectedId],
  );
  return (
    <ReactFlow<VariantFlowNode>
      className="size-full"
      nodes={nodes}
      edges={[...model.edges]}
      nodeTypes={nodeTypes}
      nodesDraggable={false}
      nodesConnectable={false}
      edgesFocusable={false}
      edgesReconnectable={false}
      panOnScroll
      fitView
      fitViewOptions={{ padding: 0.12, maxZoom: 1 }}
      minZoom={0.3}
      maxZoom={1.5}
      proOptions={{ hideAttribution: true }}
      aria-label="Variant inheritance map"
    >
      <Background variant={BackgroundVariant.Lines} gap={24} size={1} />
      <MiniMap
        pannable
        zoomable
        ariaLabel="Variant map minimap"
        nodeStrokeWidth={0}
        nodeBorderRadius={4}
        className="rounded-lg"
      />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}
