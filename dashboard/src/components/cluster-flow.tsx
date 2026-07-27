"use client";

import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  type NodeMouseHandler,
  type NodeTypes,
} from "@xyflow/react";
import { useCallback } from "react";
import {
  GroupNode,
  InstanceNode,
  PoolNode,
  QueueNode,
  SessionNode,
} from "@/components/cluster-nodes";
import type {
  ClusterFlowModel,
  ClusterFlowNode,
  ClusterSelection,
} from "@/lib/cluster-flow";

const nodeTypes: NodeTypes = {
  group: GroupNode,
  queue: QueueNode,
  pool: PoolNode,
  instance: InstanceNode,
  session: SessionNode,
};

interface ClusterFlowProps {
  readonly model: ClusterFlowModel;
  readonly onSelect: (selection: ClusterSelection) => void;
}

export function ClusterFlow({ model, onSelect }: ClusterFlowProps) {
  const handleNodeClick = useCallback<NodeMouseHandler<ClusterFlowNode>>(
    (_event, node) => {
      if (node.data.selection) onSelect(node.data.selection);
    },
    [onSelect],
  );

  return (
    <ReactFlow<ClusterFlowNode>
      nodes={model.nodes}
      edges={model.edges}
      nodeTypes={nodeTypes}
      onNodeClick={handleNodeClick}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable
      edgesFocusable={false}
      edgesReconnectable={false}
      panOnScroll
      zoomOnDoubleClick={false}
      fitView
      fitViewOptions={{ padding: 0.08, maxZoom: 1 }}
      minZoom={0.22}
      maxZoom={1.6}
      onlyRenderVisibleElements
      aria-label="Topologie du cluster EnderCloud"
    >
      <Background
        variant={BackgroundVariant.Dots}
        gap={22}
        size={1.2}
        color="var(--flow-grid)"
      />
      <MiniMap
        pannable
        zoomable
        nodeColor={(node) =>
          node.type === "instance" ? "var(--primary)" : "var(--muted-foreground)"
        }
        maskColor="var(--flow-mask)"
      />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}
