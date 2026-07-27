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
import { useDetailPanel } from "@/components/detail-panel";
import {
  GroupFrameNode,
  InstanceNode,
  PoolNode,
  QueueNode,
  SessionNode,
} from "@/components/topology/cluster-nodes";
import type { ClusterFlowModel, ClusterFlowNode } from "@/lib/cluster-flow";
import "@xyflow/react/dist/style.css";

const nodeTypes: NodeTypes = {
  groupFrame: GroupFrameNode,
  queue: QueueNode,
  pool: PoolNode,
  instance: InstanceNode,
  session: SessionNode,
};

export function ClusterFlow({ model }: { readonly model: ClusterFlowModel }) {
  const { openInstance, openSession } = useDetailPanel();

  const handleNodeClick = useCallback<NodeMouseHandler<ClusterFlowNode>>(
    (_event, node) => {
      if (node.data.kind === "instance" && node.data.instance) {
        openInstance(node.data.instance.id);
      }
      if (node.data.kind === "session" && node.data.session) {
        openSession(node.data.session.id);
      }
    },
    [openInstance, openSession],
  );

  return (
    <ReactFlow<ClusterFlowNode>
      nodes={model.nodes as ClusterFlowNode[]}
      edges={[...model.edges]}
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
      fitViewOptions={{ padding: 0.06, maxZoom: 1 }}
      minZoom={0.15}
      maxZoom={1.5}
      proOptions={{ hideAttribution: true }}
      aria-label="EnderCloud cluster topology"
    >
      <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
      {/* Colours are applied through CSS classes, not colour props: a `var()`
          inlined into an SVG presentation attribute is never resolved. */}
      <MiniMap
        pannable
        zoomable
        ariaLabel="Topology minimap"
        nodeStrokeWidth={0}
        nodeBorderRadius={3}
        nodeClassName={(node) => `rf-mini rf-mini-${node.type ?? "default"}`}
        className="rounded-lg"
      />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}
