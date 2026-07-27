"use client";

import {
  Handle,
  Position,
  type NodeProps,
} from "@xyflow/react";
import {
  BoxesIcon,
  CircleDotIcon,
  Clock3Icon,
  Gamepad2Icon,
  Layers3Icon,
  ServerIcon,
  UsersIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { formatRelativeTime } from "@/lib/format";
import type { ClusterFlowNode } from "@/lib/cluster-flow";

function Connections() {
  return (
    <>
      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} />
      <Handle id="bottom" type="source" position={Position.Bottom} />
      <Handle id="top" type="target" position={Position.Top} />
    </>
  );
}

function lifecycleVariant(
  state: string,
): "default" | "secondary" | "outline" | "destructive" {
  if (state === "FAILED" || state === "ORPHANED") return "destructive";
  if (state === "RUNNING" || state === "OPEN") return "default";
  if (state === "RESERVED") return "secondary";
  return "outline";
}

export function GroupNode({ data }: NodeProps<ClusterFlowNode>) {
  const group = data.group;
  return (
    <section
      className="cluster-group"
      data-enabled={group.enabled}
      aria-label={`Groupe ${group.id}`}
    >
      <div className="cluster-group-rail">
        <div className="flex min-w-0 items-center gap-3">
          <span className="cluster-group-index">
            {group.type === "hub" ? "HUB" : "GAME"}
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold tracking-tight">
              {group.id}
            </h2>
            <p className="text-sm text-muted-foreground">
              {group.variants.length} variante
              {group.variants.length === 1 ? "" : "s"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={group.enabled ? "default" : "outline"}>
            {group.enabled ? "ACTIF" : "DÉSACTIVÉ"}
          </Badge>
          <span className="cluster-capacity-copy">
            {group.capacity.activeInstances}/{group.capacity.maximumInstances} instances
          </span>
        </div>
      </div>
    </section>
  );
}

export function QueueNode({ data }: NodeProps<ClusterFlowNode>) {
  const queue = data.group.queue;
  return (
    <Card className="cluster-node-card cluster-clickable" data-status="queue">
      <Connections />
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle>File</CardTitle>
          <Layers3Icon aria-hidden="true" />
        </div>
        <CardDescription>Matchmaking</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="cluster-paired-metric">
          <strong>{queue.playerCount}</strong>
          <span>joueurs</span>
          <strong>{queue.partyCount}</strong>
          <span>parties</span>
        </div>
      </CardContent>
      <CardFooter>
        <Clock3Icon aria-hidden="true" />
        <span>{formatRelativeTime(queue.oldestJoinedAt)}</span>
      </CardFooter>
    </Card>
  );
}

export function PoolNode({ data }: NodeProps<ClusterFlowNode>) {
  const capacity = data.group.capacity;
  const warmTarget = Math.max(1, capacity.maximumWarmInstances);
  const progress = Math.min(
    100,
    ((capacity.warmInstances + capacity.pendingWarmInstances) / warmTarget) * 100,
  );
  return (
    <Card className="cluster-node-card" data-status="pool">
      <Connections />
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle>Pool chaude</CardTitle>
          <BoxesIcon aria-hidden="true" />
        </div>
        <CardDescription>
          cible {capacity.minimumWarmInstances}–{capacity.maximumWarmInstances}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-baseline justify-between gap-3">
          <span className="cluster-main-number">{capacity.warmInstances}</span>
          <span className="text-sm text-muted-foreground">
            +{capacity.pendingWarmInstances} en préparation
          </span>
        </div>
        <Progress value={progress} aria-label="Occupation de la pool chaude" />
      </CardContent>
      <CardFooter>
        <CircleDotIcon aria-hidden="true" />
        <span>{capacity.reservedInstances} réservée(s)</span>
      </CardFooter>
    </Card>
  );
}

export function InstanceNode({ data }: NodeProps<ClusterFlowNode>) {
  const instance = data.instance;
  if (!instance) return null;
  const state = instance.lifecycleState;
  const playerRatio =
    instance.maximumPlayers > 0
      ? Math.min(100, (instance.playerCount / instance.maximumPlayers) * 100)
      : 0;
  return (
    <Card
      className="cluster-node-card cluster-clickable"
      data-status={state.toLowerCase()}
    >
      <Connections />
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle>
            <code>{instance.id}</code>
          </CardTitle>
          <ServerIcon aria-hidden="true" />
        </div>
        <CardDescription>{instance.variantId}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap gap-2">
          <Badge variant={lifecycleVariant(state)}>{state}</Badge>
          <Badge variant={lifecycleVariant(instance.availabilityState)}>
            {instance.availabilityState}
          </Badge>
        </div>
        <div className="flex items-center justify-between gap-3 text-sm">
          <span className="flex items-center gap-1.5">
            <UsersIcon aria-hidden="true" />
            {instance.playerCount}/{instance.maximumPlayers}
          </span>
          <span className="truncate font-mono text-xs text-muted-foreground">
            {instance.endpoint ?? "endpoint en attente"}
          </span>
        </div>
        <Progress value={playerRatio} aria-label="Occupation joueurs" />
      </CardContent>
      <CardFooter>
        <Clock3Icon aria-hidden="true" />
        <span>{formatRelativeTime(instance.createdAt)}</span>
      </CardFooter>
    </Card>
  );
}

export function SessionNode({ data }: NodeProps<ClusterFlowNode>) {
  const session = data.session;
  if (!session) return null;
  return (
    <Card
      className="cluster-node-card cluster-clickable"
      data-status={session.state.toLowerCase()}
    >
      <Connections />
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle>Session</CardTitle>
          <Gamepad2Icon aria-hidden="true" />
        </div>
        <CardDescription>
          <code>{session.id}</code>
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between gap-3">
          <Badge variant={lifecycleVariant(session.state)}>
            {session.state}
          </Badge>
          <span className="text-sm">
            {session.connectedPlayerCount}/{session.activePlayerCount} connectés
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
