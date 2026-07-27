import type {
  Edge,
  MarkerType,
  Node,
  XYPosition,
} from "@xyflow/react";
import type {
  DashboardClusterSnapshot,
  DashboardGroup,
  DashboardInstance,
  DashboardSession,
} from "./contracts";

export type ClusterNodeKind = "group" | "queue" | "pool" | "instance" | "session";
export type ClusterStateFilter =
  | "all"
  | "warm"
  | "reserved"
  | "starting"
  | "attention";

export interface ClusterSelection {
  readonly kind: "queue" | "instance" | "session";
  readonly id: string;
  readonly groupId: string;
}

export interface ClusterNodeData extends Record<string, unknown> {
  readonly kind: ClusterNodeKind;
  readonly group: DashboardGroup;
  readonly instance?: DashboardInstance;
  readonly session?: DashboardSession;
  readonly selection?: ClusterSelection;
}

export type ClusterFlowNode = Node<ClusterNodeData, ClusterNodeKind>;

export interface ClusterFlowFilters {
  readonly groupId: string;
  readonly state: ClusterStateFilter;
  readonly search: string;
}

export interface ClusterFlowModel {
  readonly nodes: ClusterFlowNode[];
  readonly edges: Edge[];
  readonly width: number;
  readonly height: number;
}

const groupGap = 64;
const groupHeaderHeight = 88;
const groupPadding = 32;
const laneGap = 24;
const queueWidth = 184;
const poolWidth = 210;
const instanceWidth = 240;
const instanceColumnGap = 28;
const instanceRowHeight = 350;
const columns = 4;
const minimumGroupWidth = 1_460;

function matchesState(
  instance: DashboardInstance,
  state: ClusterStateFilter,
): boolean {
  switch (state) {
    case "warm":
      return (
        instance.lifecycleState === "RUNNING" &&
        instance.availabilityState === "OPEN"
      );
    case "reserved":
      return instance.availabilityState === "RESERVED";
    case "starting":
      return (
        instance.lifecycleState === "CREATING" ||
        instance.lifecycleState === "STARTING"
      );
    case "attention":
      return (
        instance.lifecycleState === "FAILED" ||
        instance.lifecycleState === "ORPHANED" ||
        instance.lifecycleState === "DRAINING" ||
        instance.lifecycleState === "STOPPING"
      );
    case "all":
      return true;
  }
}

function matchesSearch(
  group: DashboardGroup,
  instance: DashboardInstance,
  search: string,
): boolean {
  if (!search) return true;
  return [
    group.id,
    instance.id,
    instance.variantId,
    instance.endpoint ?? "",
    instance.sessionId ?? "",
  ].some((value) => value.toLocaleLowerCase("fr").includes(search));
}

function sessionMatchesSearch(
  group: DashboardGroup,
  session: DashboardSession,
  search: string,
): boolean {
  if (!search) return true;
  return [group.id, session.id, session.instanceId ?? "", session.state].some(
    (value) => value.toLocaleLowerCase("fr").includes(search),
  );
}

function childPosition(x: number, y: number): XYPosition {
  return { x, y };
}

function edge(
  id: string,
  source: string,
  target: string,
  dashed = false,
): Edge {
  return {
    id,
    source,
    target,
    type: "smoothstep",
    selectable: false,
    focusable: false,
    markerEnd: {
      type: "arrowclosed" as MarkerType,
      width: 14,
      height: 14,
    },
    style: dashed ? { strokeDasharray: "5 6" } : undefined,
    className: "cluster-edge",
  };
}

function groupNode(
  group: DashboardGroup,
  position: XYPosition,
  width: number,
  height: number,
): ClusterFlowNode {
  return {
    id: `group:${group.id}`,
    type: "group",
    position,
    data: { kind: "group", group },
    style: { width, height },
    selectable: false,
    draggable: false,
  };
}

export function buildClusterFlow(
  snapshot: DashboardClusterSnapshot,
  filters: ClusterFlowFilters,
): ClusterFlowModel {
  const normalizedSearch = filters.search.trim().toLocaleLowerCase("fr");
  const groups = snapshot.groups.filter(
    (group) => filters.groupId === "all" || group.id === filters.groupId,
  );
  const nodes: ClusterFlowNode[] = [];
  const edges: Edge[] = [];
  let y = 0;
  let maximumWidth = minimumGroupWidth;

  for (const group of groups) {
    const instances = group.instances.filter(
      (instance) =>
        matchesState(instance, filters.state) &&
        matchesSearch(group, instance, normalizedSearch),
    );
    const visibleInstanceIds = new Set(instances.map((instance) => instance.id));
    const sessions = group.sessions.filter((session) => {
      if (session.instanceId && !visibleInstanceIds.has(session.instanceId)) {
        return false;
      }
      return sessionMatchesSearch(group, session, normalizedSearch);
    });
    const waitingSessions = sessions.filter((session) => !session.instanceId);
    const instanceRows = Math.max(1, Math.ceil(instances.length / columns));
    const waitingHeight = Math.max(0, waitingSessions.length - 1) * 116;
    const groupHeight = Math.max(
      540 + waitingHeight,
      groupHeaderHeight + groupPadding + instanceRows * instanceRowHeight,
    );
    const groupWidth = Math.max(
      minimumGroupWidth,
      530 +
        Math.min(columns, Math.max(1, instances.length)) *
          (instanceWidth + instanceColumnGap),
    );
    maximumWidth = Math.max(maximumWidth, groupWidth);
    const parentId = `group:${group.id}`;
    nodes.push(groupNode(group, { x: 0, y }, groupWidth, groupHeight));

    const queueId = `queue:${group.id}`;
    if (group.type === "minigame") {
      nodes.push({
        id: queueId,
        parentId,
        extent: "parent",
        type: "queue",
        position: childPosition(groupPadding, groupHeaderHeight + 28),
        data: {
          kind: "queue",
          group,
          selection: { kind: "queue", id: group.id, groupId: group.id },
        },
        style: { width: queueWidth },
        draggable: false,
      });
    }

    const poolId = `pool:${group.id}`;
    const poolX =
      groupPadding + (group.type === "minigame" ? queueWidth + laneGap : 0);
    nodes.push({
      id: poolId,
      parentId,
      extent: "parent",
      type: "pool",
      position: childPosition(poolX, groupHeaderHeight + 28),
      data: { kind: "pool", group },
      style: { width: poolWidth },
      selectable: false,
      draggable: false,
    });
    if (group.type === "minigame") {
      edges.push(edge(`edge:${queueId}:${poolId}`, queueId, poolId, true));
    }

    const instancesX = poolX + poolWidth + 54;
    for (const [index, instance] of instances.entries()) {
      const column = index % columns;
      const row = Math.floor(index / columns);
      const instanceId = `instance:${instance.id}`;
      nodes.push({
        id: instanceId,
        parentId,
        extent: "parent",
        type: "instance",
        position: childPosition(
          instancesX + column * (instanceWidth + instanceColumnGap),
          groupHeaderHeight + 28 + row * instanceRowHeight,
        ),
        data: {
          kind: "instance",
          group,
          instance,
          selection: { kind: "instance", id: instance.id, groupId: group.id },
        },
        style: { width: instanceWidth },
        draggable: false,
      });
      edges.push(
        edge(
          `edge:${poolId}:${instanceId}`,
          poolId,
          instanceId,
          instance.availabilityState === "RESERVED",
        ),
      );
      const attachedSession = sessions.find(
        (session) => session.id === instance.sessionId,
      );
      if (attachedSession) {
        const sessionId = `session:${attachedSession.id}`;
        nodes.push({
          id: sessionId,
          parentId,
          extent: "parent",
          type: "session",
          position: childPosition(
            instancesX + column * (instanceWidth + instanceColumnGap),
            groupHeaderHeight + 252 + row * instanceRowHeight,
          ),
          data: {
            kind: "session",
            group,
            session: attachedSession,
            selection: {
              kind: "session",
              id: attachedSession.id,
              groupId: group.id,
            },
          },
          style: { width: instanceWidth },
          draggable: false,
        });
        edges.push(edge(`edge:${instanceId}:${sessionId}`, instanceId, sessionId));
      }
    }

    for (const [index, session] of waitingSessions.entries()) {
      const sessionId = `session:${session.id}`;
      nodes.push({
        id: sessionId,
        parentId,
        extent: "parent",
        type: "session",
        position: childPosition(poolX, groupHeaderHeight + 284 + index * 116),
        data: {
          kind: "session",
          group,
          session,
          selection: { kind: "session", id: session.id, groupId: group.id },
        },
        style: { width: poolWidth },
        draggable: false,
      });
      edges.push(edge(`edge:${poolId}:${sessionId}`, poolId, sessionId, true));
    }

    y += groupHeight + groupGap;
  }

  return {
    nodes,
    edges,
    width: maximumWidth,
    height: Math.max(0, y - groupGap),
  };
}
