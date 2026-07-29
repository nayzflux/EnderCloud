import type { Edge, MarkerType, Node } from "@xyflow/react";
import type {
  DashboardClusterSnapshot,
  DashboardGroup,
  DashboardInstance,
  DashboardSession,
} from "./contracts";
import { matchesInstanceFilter, type InstanceFilter } from "./status";

export type ClusterNodeKind =
  | "groupFrame"
  | "queue"
  | "pool"
  | "instance"
  | "session";

/** Caption drawn inside a group frame to name a row of nodes. */
export interface LaneLabel {
  readonly id: string;
  readonly text: string;
  readonly x: number;
  readonly y: number;
}

export interface ClusterNodeData extends Record<string, unknown> {
  readonly kind: ClusterNodeKind;
  readonly group: DashboardGroup;
  readonly instance?: DashboardInstance;
  readonly session?: DashboardSession;
  /** Set on session nodes that have no instance yet. */
  readonly waiting?: boolean;
  /** Set on group frames. */
  readonly lanes?: readonly LaneLabel[];
}

export type ClusterFlowNode = Node<ClusterNodeData, ClusterNodeKind>;

export interface ClusterFlowFilters {
  readonly groupId: string;
  readonly state: InstanceFilter;
  readonly search: string;
}

export interface ClusterFlowModel {
  readonly nodes: readonly ClusterFlowNode[];
  readonly edges: readonly Edge[];
}

/*
 * Each group is drawn as a top-down tree: queue → warm pool → instances →
 * sessions. Every node takes its single inbound edge on the top and emits its
 * outbound edges from the bottom, so lines can only ever run downwards — no
 * loops, no back-references, and never two lines between the same pair.
 *
 * Two line styles, one meaning each:
 *   solid  — an established link (the pool holds that instance, that instance
 *            runs that session)
 *   dashed — a pending link (that session is still waiting for an instance)
 *
 * Node sizes are declared rather than measured: the layout is deterministic, it
 * lets React Flow draw edges and the minimap without a measurement pass, and it
 * stops nodes from shifting on every five-second refresh.
 */
const HEADER_HEIGHT = 76;
const PADDING = 28;
const LANE_LABEL_HEIGHT = 24;
const COLUMN_GAP = 32;
const GROUP_GAP = 48;
const QUEUE_TO_POOL_GAP = 28;
const POOL_TO_INSTANCES_GAP = 52;
const INSTANCE_TO_SESSION_GAP = 26;

const QUEUE_SIZE = { width: 216, height: 140 } as const;
const POOL_SIZE = { width: 216, height: 116 } as const;
const INSTANCE_SIZE = { width: 260, height: 148 } as const;
const SESSION_SIZE = { width: 260, height: 124 } as const;
const WAITING_SIZE = { width: 260, height: 148 } as const;

/** Instances, waiting sessions and hosted sessions share one column pitch. */
const COLUMN_PITCH = INSTANCE_SIZE.width + COLUMN_GAP;
/** Enough room for the frame header to lay out, even with nothing under it. */
const MIN_CONTENT_WIDTH = 560;

function matchesSearch(values: readonly string[], search: string): boolean {
  if (!search) return true;
  return values.some((value) => value.toLowerCase().includes(search));
}

function edge(source: string, target: string, pending = false): Edge {
  return {
    id: `${source}->${target}`,
    source,
    target,
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
      strokeWidth: 1.5,
      ...(pending ? { strokeDasharray: "5 5" } : {}),
    },
  };
}

export function buildClusterFlow(
  snapshot: DashboardClusterSnapshot,
  filters: ClusterFlowFilters,
): ClusterFlowModel {
  const search = filters.search.trim().toLowerCase();
  const nodes: ClusterFlowNode[] = [];
  const edges: Edge[] = [];
  let offsetY = 0;

  const groups = snapshot.groups.filter(
    (group) => filters.groupId === "all" || group.id === filters.groupId,
  );

  for (const group of groups) {
    const instances = group.instances.filter(
      (instance) =>
        matchesInstanceFilter(instance, filters.state) &&
        matchesSearch(
          [
            group.id,
            instance.id,
            instance.variantId,
            instance.endpoint ?? "",
            instance.sessionId ?? "",
          ],
          search,
        ),
    );
    const visibleInstanceIds = new Set(instances.map((instance) => instance.id));
    const sessions = group.sessions.filter((session) => {
      if (session.instanceId && !visibleInstanceIds.has(session.instanceId)) {
        return false;
      }
      return matchesSearch(
        [group.id, session.id, session.instanceId ?? "", session.state],
        search,
      );
    });
    const waitingSessions = sessions.filter((session) => !session.instanceId);
    const hasQueue = group.type === "minigame";

    // Rows.
    const queueY = HEADER_HEIGHT + PADDING;
    const poolY = hasQueue ? queueY + QUEUE_SIZE.height + QUEUE_TO_POOL_GAP : queueY;
    const instancesY =
      poolY + POOL_SIZE.height + POOL_TO_INSTANCES_GAP + LANE_LABEL_HEIGHT;
    const sessionsY = instancesY + INSTANCE_SIZE.height + INSTANCE_TO_SESSION_GAP;

    // Columns: instances first, then any session still waiting for capacity.
    const columnCount = instances.length + waitingSessions.length;
    const rowSpan = columnCount > 0 ? columnCount * COLUMN_PITCH - COLUMN_GAP : 0;
    const contentWidth = Math.max(
      rowSpan,
      POOL_SIZE.width,
      QUEUE_SIZE.width,
      MIN_CONTENT_WIDTH,
    );
    const columnsX = PADDING + (contentWidth - rowSpan) / 2;
    const groupWidth = contentWidth + PADDING * 2;

    const hasHostedSession = instances.some((instance) =>
      sessions.some((session) => session.id === instance.sessionId),
    );

    const frameId = `group:${group.id}`;
    const lanes: LaneLabel[] = [];
    let groupHeight: number;

    if (columnCount === 0) {
      // Nothing to lay out below the pool: stop the frame right after it.
      lanes.push({
        id: "instances",
        text: "No instance running",
        x: PADDING,
        y: poolY + POOL_SIZE.height + 22,
      });
      groupHeight = poolY + POOL_SIZE.height + 22 + LANE_LABEL_HEIGHT + PADDING;
    } else {
      lanes.push({
        id: "instances",
        text: `Instances · ${instances.length}`,
        x: columnsX,
        y: instancesY - LANE_LABEL_HEIGHT,
      });
      if (waitingSessions.length > 0) {
        lanes.push({
          id: "waiting",
          text: "Waiting for capacity",
          x: columnsX + instances.length * COLUMN_PITCH,
          y: instancesY - LANE_LABEL_HEIGHT,
        });
      }
      groupHeight =
        (hasHostedSession
          ? sessionsY + SESSION_SIZE.height
          : instancesY + INSTANCE_SIZE.height) + PADDING;
    }

    nodes.push({
      id: frameId,
      type: "groupFrame",
      position: { x: 0, y: offsetY },
      width: groupWidth,
      height: groupHeight,
      data: { kind: "groupFrame", group, lanes },
      style: { width: groupWidth, height: groupHeight },
      selectable: false,
      draggable: false,
      zIndex: 0,
    });

    const poolId = `pool:${group.id}`;

    if (hasQueue) {
      const queueId = `queue:${group.id}`;
      nodes.push({
        id: queueId,
        parentId: frameId,
        extent: "parent",
        type: "queue",
        position: {
          x: PADDING + (contentWidth - QUEUE_SIZE.width) / 2,
          y: queueY,
        },
        ...QUEUE_SIZE,
        data: { kind: "queue", group },
        style: QUEUE_SIZE,
        draggable: false,
        selectable: false,
      });
      edges.push(edge(queueId, poolId));
    }

    nodes.push({
      id: poolId,
      parentId: frameId,
      extent: "parent",
      type: "pool",
      position: { x: PADDING + (contentWidth - POOL_SIZE.width) / 2, y: poolY },
      ...POOL_SIZE,
      data: { kind: "pool", group },
      style: POOL_SIZE,
      draggable: false,
      selectable: false,
    });

    for (const [index, instance] of instances.entries()) {
      const x = columnsX + index * COLUMN_PITCH;
      const instanceNodeId = `instance:${instance.id}`;

      nodes.push({
        id: instanceNodeId,
        parentId: frameId,
        extent: "parent",
        type: "instance",
        position: { x, y: instancesY },
        ...INSTANCE_SIZE,
        data: { kind: "instance", group, instance },
        style: INSTANCE_SIZE,
        draggable: false,
      });
      edges.push(edge(poolId, instanceNodeId));

      const hosted = sessions.find(
        (session) => session.id === instance.sessionId,
      );
      if (hosted) {
        const sessionNodeId = `session:${hosted.id}`;
        nodes.push({
          id: sessionNodeId,
          parentId: frameId,
          extent: "parent",
          type: "session",
          position: { x, y: sessionsY },
          ...SESSION_SIZE,
          data: { kind: "session", group, session: hosted },
          style: SESSION_SIZE,
          draggable: false,
        });
        edges.push(edge(instanceNodeId, sessionNodeId));
      }
    }

    for (const [index, session] of waitingSessions.entries()) {
      const sessionNodeId = `session:${session.id}`;
      nodes.push({
        id: sessionNodeId,
        parentId: frameId,
        extent: "parent",
        type: "session",
        position: {
          x: columnsX + (instances.length + index) * COLUMN_PITCH,
          y: instancesY,
        },
        ...WAITING_SIZE,
        data: { kind: "session", group, session, waiting: true },
        style: WAITING_SIZE,
        draggable: false,
      });
      edges.push(edge(poolId, sessionNodeId, true));
    }

    offsetY += groupHeight + GROUP_GAP;
  }

  return { nodes, edges };
}
