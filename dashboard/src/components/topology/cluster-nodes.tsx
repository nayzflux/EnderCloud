"use client";

import { Handle, Position, type NodeProps } from "@xyflow/react";
import {
  BoxesIcon,
  Gamepad2Icon,
  HourglassIcon,
  ListOrderedIcon,
  ServerIcon,
} from "lucide-react";
import { GroupTypeBadge, StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import type { ClusterFlowNode } from "@/lib/cluster-flow";
import { formatAge, humanizeState, ratio } from "@/lib/format";
import {
  lifecycleTone,
  sessionTone,
  toneBorderClass,
  toneDotClass,
} from "@/lib/status";
import { cn } from "@/lib/utils";

/**
 * Node sizes are declared in the layout rather than measured, so every card
 * fills the box the diagram reserved for it.
 */
function NodeCard({
  children,
  ring = "ring-foreground/10",
  interactive,
  dashed,
}: {
  readonly children: React.ReactNode;
  readonly ring?: string;
  readonly interactive?: boolean;
  readonly dashed?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex size-full flex-col overflow-hidden rounded-xl bg-card p-3 text-card-foreground ring-1 transition-shadow",
        ring,
        dashed && "border border-dashed border-muted-foreground/50 bg-card/60",
        interactive &&
          "cursor-pointer hover:shadow-lg hover:ring-2 focus-visible:ring-2 focus-visible:ring-ring",
      )}
    >
      {children}
    </div>
  );
}

/** Inbound on top, outbound at the bottom: edges can only ever run downwards. */
function Ports({
  inbound,
  outbound,
}: {
  readonly inbound?: boolean;
  readonly outbound?: boolean;
}) {
  return (
    <>
      {inbound ? <Handle id="in" type="target" position={Position.Top} /> : null}
      {outbound ? (
        <Handle id="out" type="source" position={Position.Bottom} />
      ) : null}
    </>
  );
}

function MetricBar({ percent }: { readonly percent: number }) {
  return (
    <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
      <div
        className="h-full rounded-full bg-foreground/60 transition-[width] duration-500"
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

function CardLabel({
  children,
  icon: Icon,
}: {
  readonly children: React.ReactNode;
  readonly icon: React.ComponentType<{ className?: string }>;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {children}
      </span>
      <Icon className="size-3.5 text-muted-foreground" />
    </div>
  );
}

export function GroupFrameNode({ data }: NodeProps<ClusterFlowNode>) {
  const group = data.group;
  return (
    <section
      aria-label={`Group ${group.id}`}
      className={cn(
        "relative size-full overflow-hidden rounded-2xl bg-muted/40 ring-1 ring-border",
        !group.enabled && "opacity-60",
      )}
    >
      <header className="flex h-[76px] items-center justify-between gap-4 border-b bg-card px-5">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
            {group.type === "hub" ? (
              <BoxesIcon className="size-4" />
            ) : (
              <Gamepad2Icon className="size-4" />
            )}
          </span>
          <div className="min-w-0">
            <h2 className="truncate font-heading text-base font-semibold">
              {group.id}
            </h2>
            <p className="text-xs text-muted-foreground">
              {group.variants.length} variant
              {group.variants.length === 1 ? "" : "s"} · {group.instances.length}{" "}
              instance{group.instances.length === 1 ? "" : "s"}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <GroupTypeBadge type={group.type} />
          {group.enabled ? null : <Badge variant="outline">disabled</Badge>}
          <span className="font-mono text-xs text-muted-foreground tabular">
            {group.capacity.activeInstances}/{group.capacity.maximumInstances}
          </span>
        </div>
      </header>

      {/* Column captions, so the layout itself explains what each area holds. */}
      {(data.lanes ?? []).map((lane) => (
        <span
          key={lane.id}
          className="absolute text-[0.7rem] font-semibold tracking-wide text-muted-foreground uppercase"
          style={{ left: lane.x, top: lane.y }}
        >
          {lane.text}
        </span>
      ))}
    </section>
  );
}

export function QueueNode({ data }: NodeProps<ClusterFlowNode>) {
  const { queue, matchmaking } = data.group;
  const threshold = matchmaking?.minimumPlayers ?? 0;

  return (
    <NodeCard>
      <Ports outbound />
      <CardLabel icon={ListOrderedIcon}>Queue</CardLabel>
      <div className="mt-2 flex items-baseline gap-2">
        <span className="font-heading text-2xl leading-none font-semibold tabular">
          {queue.playerCount}
        </span>
        <span className="text-xs text-muted-foreground">
          player{queue.playerCount === 1 ? "" : "s"} · {queue.partyCount} part
          {queue.partyCount === 1 ? "y" : "ies"}
        </span>
      </div>
      {threshold > 0 ? (
        <div className="mt-2.5 space-y-1">
          <MetricBar percent={ratio(queue.playerCount, threshold)} />
          <p className="text-[0.7rem] text-muted-foreground tabular">
            {queue.playerCount}/{threshold} to form a match
          </p>
        </div>
      ) : null}
      <p className="mt-2 text-[0.7rem] text-muted-foreground">
        {queue.oldestJoinedAt
          ? `oldest ${formatAge(queue.oldestJoinedAt)}`
          : "no party waiting"}
      </p>
    </NodeCard>
  );
}

export function PoolNode({ data }: NodeProps<ClusterFlowNode>) {
  const { capacity } = data.group;
  const target = Math.max(1, capacity.maximumWarmInstances);
  const percent = ratio(
    capacity.warmInstances + capacity.pendingWarmInstances,
    target,
  );

  return (
    <NodeCard>
      <Ports inbound outbound />
      <CardLabel icon={BoxesIcon}>Warm pool</CardLabel>
      <div className="mt-2 flex items-baseline gap-2">
        <span className="font-heading text-2xl leading-none font-semibold tabular">
          {capacity.warmInstances}
        </span>
        <span className="text-xs text-muted-foreground">
          target {capacity.minimumWarmInstances}–{capacity.maximumWarmInstances}
        </span>
      </div>
      <div className="mt-2.5 space-y-1">
        <MetricBar percent={percent} />
        <p className="text-[0.7rem] text-muted-foreground tabular">
          {capacity.pendingWarmInstances > 0
            ? `+${capacity.pendingWarmInstances} starting · `
            : ""}
          {capacity.reservedInstances} reserved
        </p>
      </div>
    </NodeCard>
  );
}

export function InstanceNode({ data }: NodeProps<ClusterFlowNode>) {
  const instance = data.instance;
  if (!instance) return null;
  const tone = lifecycleTone(instance.lifecycleState);

  return (
    <NodeCard ring={toneBorderClass[tone]} interactive>
      <Ports inbound outbound />
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-mono text-xs font-medium">{instance.id}</p>
          <p className="truncate text-[0.7rem] text-muted-foreground">
            {instance.variantId}
          </p>
        </div>
        <ServerIcon className="size-3.5 shrink-0 text-muted-foreground" />
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <StatusBadge tone={tone} label={humanizeState(instance.lifecycleState)} />
        <Badge variant="outline" className="text-[0.65rem]">
          {instance.availabilityState === "RESERVED" ? "reserved" : "open"}
        </Badge>
      </div>

      <div className="mt-2.5 space-y-1">
        <div className="flex items-center justify-between gap-2 text-[0.7rem] text-muted-foreground">
          <span className="tabular">
            {instance.playerCount}/{instance.maximumPlayers} players
          </span>
          <span className="tabular">{formatAge(instance.createdAt)}</span>
        </div>
        <MetricBar
          percent={ratio(instance.playerCount, instance.maximumPlayers)}
        />
        <p className="truncate font-mono text-[0.68rem] text-muted-foreground">
          {instance.endpoint ?? "endpoint pending"}
        </p>
      </div>
    </NodeCard>
  );
}

export function SessionNode({ data }: NodeProps<ClusterFlowNode>) {
  const session = data.session;
  if (!session) return null;
  const tone = sessionTone(session.state);
  const waiting = data.waiting === true;

  return (
    <NodeCard
      ring={waiting ? "ring-transparent" : toneBorderClass[tone]}
      dashed={waiting}
      interactive
    >
      <Ports inbound />
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-medium">Session</p>
          <p className="truncate font-mono text-[0.7rem] text-muted-foreground">
            {session.id}
          </p>
        </div>
        {waiting ? (
          <HourglassIcon className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <Gamepad2Icon className="size-3.5 shrink-0 text-muted-foreground" />
        )}
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-[0.7rem] text-muted-foreground">
          <span
            aria-hidden
            className={cn("size-1.5 rounded-full", toneDotClass[tone])}
          />
          {humanizeState(session.state)}
        </span>
        <span className="font-mono text-[0.7rem] tabular">
          {session.connectedPlayerCount}/{session.activePlayerCount}
        </span>
      </div>
      {waiting ? (
        <p className="mt-1.5 text-[0.68rem] text-muted-foreground">
          No instance assigned yet
        </p>
      ) : null}
    </NodeCard>
  );
}
