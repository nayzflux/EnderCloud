"use client";

import {
  ActivityIcon,
  BoxesIcon,
  CircleCheckIcon,
  Gamepad2Icon,
  ServerIcon,
  UsersIcon,
} from "lucide-react";
import Link from "next/link";
import { useMemo, type ReactNode } from "react";
import { Bar, BarChart, CartesianGrid, Cell, XAxis, YAxis } from "recharts";
import { ClusterGate } from "@/components/cluster-gate";
import { useDetailPanel } from "@/components/detail-panel";
import { PageHeader } from "@/components/page-header";
import { StatCard } from "@/components/stat-card";
import {
  GroupTypeBadge,
  LifecycleBadge,
  SessionStateBadge,
} from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type {
  DashboardClusterSnapshot,
  DashboardGroup,
  LifecycleState,
} from "@/lib/contracts";
import { Elapsed } from "@/components/live-time";
import { humanizeState, ratio } from "@/lib/format";
import { lifecycleTone, needsAttention, toneChartColor } from "@/lib/status";

const lifecycleOrder: readonly LifecycleState[] = [
  "CREATING",
  "STARTING",
  "RUNNING",
  "DRAINING",
  "STOPPING",
  "STOPPED",
  "FAILED",
  "ORPHANED",
];

const fleetChartConfig = {
  count: { label: "Instances" },
} satisfies ChartConfig;

function activeSessionCount(group: DashboardGroup): number {
  return group.sessions.filter(
    (session) =>
      session.state !== "FINISHED" &&
      session.state !== "CANCELLED" &&
      session.state !== "FAILED",
  ).length;
}

/* ---------------------------------------------------------------- fleet --- */

function FleetChart({ snapshot }: { readonly snapshot: DashboardClusterSnapshot }) {
  const data = useMemo(() => {
    const counts = new Map<LifecycleState, number>();
    for (const group of snapshot.groups) {
      for (const instance of group.instances) {
        counts.set(
          instance.lifecycleState,
          (counts.get(instance.lifecycleState) ?? 0) + 1,
        );
      }
    }
    return lifecycleOrder
      .filter((state) => (counts.get(state) ?? 0) > 0)
      .map((state) => ({
        state: humanizeState(state),
        count: counts.get(state) ?? 0,
        fill: toneChartColor[lifecycleTone(state)],
      }));
  }, [snapshot]);

  if (data.length === 0) {
    return (
      <p className="py-12 text-center text-sm text-muted-foreground">
        No instance is running right now.
      </p>
    );
  }

  return (
    <ChartContainer config={fleetChartConfig} className="aspect-auto h-52 w-full">
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -24 }}>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis
          dataKey="state"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          interval={0}
          fontSize={11}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          allowDecimals={false}
          width={36}
          fontSize={11}
        />
        <ChartTooltip content={<ChartTooltipContent hideLabel={false} />} />
        <Bar dataKey="count" radius={[6, 6, 0, 0]} maxBarSize={52}>
          {data.map((entry) => (
            <Cell key={entry.state} fill={entry.fill} />
          ))}
        </Bar>
      </BarChart>
    </ChartContainer>
  );
}

/* ------------------------------------------------------------ attention --- */

interface AttentionItem {
  readonly key: string;
  readonly id: string;
  readonly groupId: string;
  readonly detail: ReactNode;
  readonly badge: React.ReactNode;
  readonly open: () => void;
}

function AttentionCard({
  snapshot,
}: {
  readonly snapshot: DashboardClusterSnapshot;
}) {
  const { openInstance, openSession } = useDetailPanel();

  const items: AttentionItem[] = [
    ...snapshot.groups.flatMap((group) =>
      group.instances.filter(needsAttention).map((instance) => ({
        key: `instance:${instance.id}`,
        id: instance.id,
        groupId: group.id,
        detail: (
          <>
            {instance.variantId} · <Elapsed value={instance.createdAt} /> old
          </>
        ),
        badge: <LifecycleBadge state={instance.lifecycleState} />,
        open: () => openInstance(instance.id),
      })),
    ),
    ...snapshot.groups.flatMap((group) =>
      group.sessions
        .filter(
          (session) =>
            session.state === "WAITING_FOR_INSTANCE" ||
            session.state === "WAITING" ||
            session.state === "FAILED",
        )
        .map((session) => ({
          key: `session:${session.id}`,
          id: session.id,
          groupId: group.id,
          detail: (
            <>
              {session.activePlayerCount}/{session.maximumPlayerCount} in session
              · {session.connectedPlayerCount}/{session.activePlayerCount}{" "}
              transferred · waiting <Elapsed value={session.createdAt} />
            </>
          ),
          badge: <SessionStateBadge state={session.state} />,
          open: () => openSession(session.id),
        })),
    ),
  ];

  return (
    <Card className="gap-0">
      <CardHeader className="border-b pb-4">
        <CardTitle>Needs attention</CardTitle>
        <CardDescription>
          Degraded instances and sessions still waiting for capacity.
        </CardDescription>
        <CardAction>
          <Badge variant={items.length > 0 ? "destructive" : "secondary"}>
            {items.length}
          </Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="px-0">
        {items.length === 0 ? (
          <Empty className="py-10">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <CircleCheckIcon className="text-success" />
              </EmptyMedia>
              <EmptyTitle>Everything is nominal</EmptyTitle>
              <EmptyDescription>
                No degraded instance, and no session stuck waiting.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ScrollArea className="max-h-64">
            <ul className="divide-y">
              {items.map((item) => (
                <li key={item.key}>
                  <button
                    type="button"
                    onClick={item.open}
                    className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-muted/60"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-mono text-xs">
                        {item.id}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {item.groupId} · {item.detail}
                      </span>
                    </span>
                    {item.badge}
                  </button>
                </li>
              ))}
            </ul>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  );
}

/* --------------------------------------------------------------- groups --- */

function GroupsTable({
  snapshot,
}: {
  readonly snapshot: DashboardClusterSnapshot;
}) {
  return (
    <Card className="gap-0 py-0">
      <CardHeader className="border-b py-4">
        <CardTitle>Groups</CardTitle>
        <CardDescription>
          Capacity, occupancy and queue pressure for each configured group.
        </CardDescription>
        <CardAction>
          <Button
            variant="ghost"
            size="xs"
            nativeButton={false}
            render={<Link href="/groups" />}
          >
            All groups
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="px-0 pb-2">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="pl-4 text-xs text-muted-foreground">
                Group
              </TableHead>
              <TableHead className="w-48 text-xs text-muted-foreground">
                Instances
              </TableHead>
              <TableHead className="hidden text-right text-xs text-muted-foreground sm:table-cell">
                Warm
              </TableHead>
              <TableHead className="hidden text-right text-xs text-muted-foreground sm:table-cell">
                Reserved
              </TableHead>
              <TableHead className="hidden text-right text-xs text-muted-foreground md:table-cell">
                Sessions
              </TableHead>
              <TableHead className="text-right text-xs text-muted-foreground">
                Players
              </TableHead>
              <TableHead className="pr-4 text-right text-xs text-muted-foreground">
                Queue
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {snapshot.groups.map((group) => {
              const { capacity } = group;
              const players = group.instances.reduce(
                (total, instance) => total + instance.playerCount,
                0,
              );
              const attention = group.instances.filter(needsAttention).length;

              return (
                <TableRow key={group.id}>
                  <TableCell className="pl-4">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs">{group.id}</span>
                      <GroupTypeBadge type={group.type} />
                      {group.enabled ? null : (
                        <Badge variant="outline" className="text-[0.65rem]">
                          disabled
                        </Badge>
                      )}
                      {attention > 0 ? (
                        <Badge variant="destructive" className="text-[0.65rem]">
                          {attention} degraded
                        </Badge>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <div className="h-1 w-24 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full bg-foreground/60 transition-[width] duration-500"
                          style={{
                            width: `${ratio(capacity.activeInstances, capacity.maximumInstances)}%`,
                          }}
                        />
                      </div>
                      <span className="font-mono text-xs text-muted-foreground tabular">
                        {capacity.activeInstances}/{capacity.maximumInstances}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="hidden text-right font-mono text-xs tabular sm:table-cell">
                    {capacity.warmInstances}
                    {capacity.pendingWarmInstances > 0 ? (
                      <span className="text-muted-foreground">
                        {" "}
                        +{capacity.pendingWarmInstances}
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell className="hidden text-right font-mono text-xs tabular sm:table-cell">
                    {capacity.reservedInstances}
                  </TableCell>
                  <TableCell className="hidden text-right font-mono text-xs tabular md:table-cell">
                    {activeSessionCount(group)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs tabular">
                    {players}
                  </TableCell>
                  <TableCell className="pr-4 text-right font-mono text-xs tabular">
                    {group.type === "hub" ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <>
                        {group.queue.playerCount}
                        <span className="text-muted-foreground">
                          {" "}
                          / {group.queue.partyCount}p
                        </span>
                      </>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

/* ----------------------------------------------------------------- page --- */

export default function OverviewPage() {
  return (
    <>
      <PageHeader
        title="Cluster overview"
        description="Fleet health, capacity per group and anything that needs attention."
        actions={
          <Button
            variant="outline"
            size="sm"
            nativeButton={false}
            render={<Link href="/topology" />}
          >
            <ActivityIcon data-icon="inline-start" />
            Open topology
          </Button>
        }
      />
      <ClusterGate>
        {(snapshot) => {
          const summary = snapshot.summary;
          const capacityTotal = snapshot.groups.reduce(
            (total, group) => total + group.capacity.maximumInstances,
            0,
          );

          return (
            <>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <StatCard
                  label="Instances"
                  value={summary.activeInstances}
                  icon={ServerIcon}
                  hint={`${summary.runningInstances} running`}
                  progress={ratio(summary.activeInstances, capacityTotal)}
                  progressLabel={`${summary.activeInstances} of ${capacityTotal} maximum`}
                />
                <StatCard
                  label="Warm pool"
                  value={summary.warmInstances}
                  icon={BoxesIcon}
                  tone="success"
                  hint={
                    summary.pendingWarmInstances > 0
                      ? `+${summary.pendingWarmInstances} starting`
                      : "ready to reserve"
                  }
                />
                <StatCard
                  label="Sessions"
                  value={summary.activeSessions}
                  icon={Gamepad2Icon}
                  hint={`${summary.reservedInstances} instances reserved`}
                />
                <StatCard
                  label="Players"
                  value={summary.playersOnline}
                  icon={UsersIcon}
                  hint={`${summary.queuedPlayers} queued`}
                />
              </div>

              <div className="grid gap-4 lg:grid-cols-2">
                <Card className="gap-0">
                  <CardHeader className="border-b pb-4">
                    <CardTitle>Fleet health</CardTitle>
                    <CardDescription>
                      Managed containers by lifecycle state.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="pt-4">
                    <FleetChart snapshot={snapshot} />
                  </CardContent>
                </Card>

                <AttentionCard snapshot={snapshot} />
              </div>

              <GroupsTable snapshot={snapshot} />
            </>
          );
        }}
      </ClusterGate>
    </>
  );
}
