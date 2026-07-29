"use client";

import { useQuery } from "@tanstack/react-query";
import {
  CircleAlertIcon,
  HourglassIcon,
  ListOrderedIcon,
  TimerIcon,
  UsersIcon,
} from "lucide-react";
import { useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, Cell, XAxis, YAxis } from "recharts";
import { ClusterGate } from "@/components/cluster-gate";
import { CopyableId } from "@/components/copyable-id";
import { DataTable, type Column } from "@/components/data-table";
import { PageHeader, SectionTitle } from "@/components/page-header";
import { StatCard } from "@/components/stat-card";
import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { fetchQueue } from "@/lib/api";
import type {
  DashboardClusterSnapshot,
  DashboardGroup,
  DashboardQueueDetail,
} from "@/lib/contracts";
import { Elapsed } from "@/components/live-time";
import { useNow } from "@/lib/clock";
import { formatDuration, formatNumber, ratio } from "@/lib/format";
import { toneChartColor, type Tone } from "@/lib/status";

const QUEUE_LIMIT = 200;

/** Wait buckets, from freshly queued to worryingly stale. */
const waitBuckets: readonly {
  readonly label: string;
  readonly maxSeconds: number;
  readonly tone: Tone;
}[] = [
  { label: "< 15s", maxSeconds: 15, tone: "success" },
  { label: "15–30s", maxSeconds: 30, tone: "success" },
  { label: "30–60s", maxSeconds: 60, tone: "info" },
  { label: "1–2m", maxSeconds: 120, tone: "warning" },
  { label: "2–5m", maxSeconds: 300, tone: "warning" },
  { label: "> 5m", maxSeconds: Number.POSITIVE_INFINITY, tone: "danger" },
];

const waitChartConfig = {
  parties: { label: "Parties" },
} satisfies ChartConfig;

function bucketIndex(waitSeconds: number): number {
  return waitBuckets.findIndex((bucket) => waitSeconds < bucket.maxSeconds);
}

interface QueueRow {
  readonly id: string;
  readonly partyId: string;
  readonly joinedAt: string;
  readonly players: readonly string[];
  readonly position: number;
}

function PlayersPopover({ players }: { readonly players: readonly string[] }) {
  return (
    <Popover>
      <PopoverTrigger
        render={<Button variant="outline" size="xs" />}
        onClick={(event) => event.stopPropagation()}
      >
        <UsersIcon data-icon="inline-start" />
        {players.length}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="border-b px-3 py-2">
          <p className="text-sm font-medium">
            {players.length} player{players.length === 1 ? "" : "s"} in party
          </p>
        </div>
        <ScrollArea className="max-h-64">
          <ul className="divide-y">
            {players.map((player) => (
              <li key={player} className="px-3 py-1.5">
                <CopyableId value={player} label="player id" />
              </li>
            ))}
          </ul>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}

/** Subscribes to the clock on its own, so the parties table is not re-rendered. */
function WaitBadge({ joinedAt }: { readonly joinedAt: string }) {
  const now = useNow();
  const waitSeconds = Math.max(0, (now - Date.parse(joinedAt)) / 1_000);
  const index = bucketIndex(waitSeconds);
  const tone = waitBuckets[index === -1 ? waitBuckets.length - 1 : index].tone;
  return <StatusBadge tone={tone} label={<Elapsed value={joinedAt} />} />;
}

function WaitDistribution({ rows }: { readonly rows: readonly QueueRow[] }) {
  const now = useNow();
  const data = useMemo(() => {
    const counts = waitBuckets.map(() => 0);
    for (const row of rows) {
      const waitSeconds = Math.max(0, (now - Date.parse(row.joinedAt)) / 1_000);
      const index = bucketIndex(waitSeconds);
      counts[index === -1 ? waitBuckets.length - 1 : index] += 1;
    }
    return waitBuckets.map((bucket, index) => ({
      bucket: bucket.label,
      parties: counts[index],
      fill: toneChartColor[bucket.tone],
    }));
  }, [now, rows]);

  return (
    <ChartContainer
      config={waitChartConfig}
      // Fills the card, which the grid stretches to match the parties table.
      className="aspect-auto h-full min-h-48 w-full"
    >
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -24 }}>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis
          dataKey="bucket"
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
          width={40}
          fontSize={11}
        />
        <ChartTooltip content={<ChartTooltipContent hideLabel={false} />} />
        <Bar dataKey="parties" radius={[6, 6, 0, 0]} maxBarSize={48}>
          {data.map((entry) => (
            <Cell key={entry.bucket} fill={entry.fill} />
          ))}
        </Bar>
      </BarChart>
    </ChartContainer>
  );
}

function QueuePanel({ group }: { readonly group: DashboardGroup }) {
  const query = useQuery({
    queryKey: ["queue", group.id],
    queryFn: () => fetchQueue(group.id, QUEUE_LIMIT),
    refetchInterval: 5_000,
    placeholderData: (previous) => previous,
  });

  const columns = useMemo<readonly Column<QueueRow>[]>(
    () => [
      {
        id: "position",
        header: "#",
        align: "right",
        cell: (row) => (
          <span className="font-mono text-xs text-muted-foreground tabular">
            {row.position}
          </span>
        ),
        sortValue: (row) => row.position,
      },
      {
        id: "party",
        header: "Party",
        cell: (row) => <CopyableId value={row.partyId} label="party id" />,
        sortValue: (row) => row.partyId,
      },
      {
        id: "size",
        header: "Size",
        cell: (row) => (
          <span className="font-mono text-xs tabular">{row.players.length}</span>
        ),
        sortValue: (row) => row.players.length,
      },
      {
        id: "wait",
        header: "Waiting for",
        cell: (row) => <WaitBadge joinedAt={row.joinedAt} />,
        sortValue: (row) => Date.parse(row.joinedAt),
      },
      {
        id: "players",
        header: "Players",
        align: "right",
        cell: (row) => <PlayersPopover players={row.players} />,
      },
    ],
    [],
  );

  if (query.isPending) {
    return (
      <div className="flex flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }, (_unused, index) => (
            <Skeleton key={index} className="h-24 w-full rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    );
  }

  if (query.isError) {
    return (
      <Alert variant="destructive">
        <CircleAlertIcon />
        <AlertTitle>Queue unavailable</AlertTitle>
        <AlertDescription>{query.error.message}</AlertDescription>
      </Alert>
    );
  }

  const detail: DashboardQueueDetail = query.data;
  const rows: QueueRow[] = detail.entries.map((entry, index) => ({
    ...entry,
    position: index + 1,
  }));

  const minimumPlayers = group.matchmaking?.minimumPlayers ?? 0;
  const readiness = minimumPlayers > 0 ? ratio(detail.totalPlayers, minimumPlayers) : 0;
  const ready = minimumPlayers > 0 && detail.totalPlayers >= minimumPlayers;
  const oldestJoinedAt = detail.entries.at(0)?.joinedAt ?? null;
  // Tones change rarely, so the snapshot instant is precise enough for them;
  // only the rendered durations need to tick.
  const snapshotAt = Date.parse(detail.generatedAt);
  const averageSize =
    detail.totalParties > 0 ? detail.totalPlayers / detail.totalParties : 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Parties waiting"
          value={detail.totalParties}
          icon={ListOrderedIcon}
          hint={
            detail.totalParties > 0
              ? `avg ${averageSize.toFixed(1)} players`
              : undefined
          }
        />
        <StatCard
          label="Players waiting"
          value={detail.totalPlayers}
          icon={UsersIcon}
          tone={ready ? "success" : "neutral"}
          progress={readiness}
          progressLabel={
            minimumPlayers > 0
              ? ready
                ? `Threshold of ${minimumPlayers} reached`
                : `${detail.totalPlayers}/${minimumPlayers} needed to form a match`
              : undefined
          }
        />
        <StatCard
          label="Longest wait"
          value={<Elapsed value={oldestJoinedAt} />}
          icon={HourglassIcon}
          tone={
            oldestJoinedAt &&
            snapshotAt - Date.parse(oldestJoinedAt) >
              (group.matchmaking?.waitingTimeoutMs ?? 60_000)
              ? "warning"
              : "neutral"
          }
          hint={
            group.matchmaking
              ? `timeout ${formatDuration(group.matchmaking.waitingTimeoutMs)}`
              : undefined
          }
        />
        <StatCard
          label="Warm capacity"
          value={group.capacity.warmInstances}
          icon={TimerIcon}
          tone={
            group.capacity.warmInstances === 0 && detail.totalParties > 0
              ? "danger"
              : "success"
          }
          hint={
            group.capacity.pendingWarmInstances > 0
              ? `+${group.capacity.pendingWarmInstances} starting`
              : "instances ready to reserve"
          }
        />
      </div>

      {group.enabled ? null : (
        <Alert>
          <CircleAlertIcon />
          <AlertTitle>Group disabled</AlertTitle>
          <AlertDescription>
            This group is disabled, so the matchmaker will not consume its queue.
          </AlertDescription>
        </Alert>
      )}

      {detail.totalParties === 0 ? (
        <Card>
          <CardContent>
            <Empty className="py-10">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <ListOrderedIcon />
                </EmptyMedia>
                <EmptyTitle>Queue is empty</EmptyTitle>
                <EmptyDescription>
                  No party is waiting for a{" "}
                  <span className="font-mono">{group.id}</span> match right now.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 xl:grid-cols-3">
          <Card className="gap-0 xl:col-span-1">
            <CardHeader className="border-b pb-4">
              <CardTitle>Wait distribution</CardTitle>
              <CardDescription>
                How long the queued parties have been waiting.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex min-h-0 flex-1 flex-col pt-4">
              <WaitDistribution rows={rows} />
            </CardContent>
          </Card>

          <Card className="py-0 xl:col-span-2">
            <CardHeader className="border-b py-4">
              <CardTitle>Queued parties</CardTitle>
              <CardDescription>
                Ordered oldest first — the next parties the matchmaker will take.
              </CardDescription>
              <CardAction>
                {detail.truncated ? (
                  <Badge variant="outline">first {QUEUE_LIMIT}</Badge>
                ) : null}
              </CardAction>
            </CardHeader>
            <CardContent className="px-0 py-2">
              <DataTable
                rows={rows}
                columns={columns}
                getRowId={(row) => row.id}
                initialSort={{ columnId: "position" }}
                pageSize={15}
                caption={`Parties queued for ${group.id}`}
              />
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

function QueuesView({ snapshot }: { readonly snapshot: DashboardClusterSnapshot }) {
  const groups = snapshot.groups.filter((group) => group.matchmaking !== null);
  const [selected, setSelected] = useState<string>(groups.at(0)?.id ?? "");

  if (groups.length === 0) {
    return (
      <>
        <Card>
          <CardContent>
            <Empty className="py-12">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <ListOrderedIcon />
                </EmptyMedia>
                <EmptyTitle>No matchmaking group</EmptyTitle>
                <EmptyDescription>
                  Only minigame groups run matchmaking. Hub groups route players
                  directly, so they never queue.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          </CardContent>
        </Card>
      </>
    );
  }

  const activeGroup =
    groups.find((group) => group.id === selected) ?? groups[0];
  const totalParties = groups.reduce(
    (total, group) => total + group.queue.partyCount,
    0,
  );
  const totalPlayers = groups.reduce(
    (total, group) => total + group.queue.playerCount,
    0,
  );
  const oldestOverall = groups
    .map((group) => group.queue.oldestJoinedAt)
    .filter((value): value is string => value !== null)
    .sort()
    .at(0);
  const groupsQueueing = groups.filter(
    (group) => group.queue.partyCount > 0,
  ).length;

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Parties queued"
          value={totalParties}
          icon={ListOrderedIcon}
        />
        <StatCard
          label="Players queued"
          value={totalPlayers}
          icon={UsersIcon}
        />
        <StatCard
          label="Longest wait"
          value={<Elapsed value={oldestOverall} />}
          icon={HourglassIcon}
          tone={oldestOverall ? "warning" : "neutral"}
        />
        <StatCard
          label="Active queues"
          value={groupsQueueing}
          icon={TimerIcon}
          hint={`of ${groups.length} matchmaking groups`}
        />
      </div>

      <SectionTitle>Queue by group</SectionTitle>

      <Tabs
        value={activeGroup.id}
        onValueChange={(value) => setSelected(String(value))}
        className="gap-4"
      >
        <TabsList variant="line" className="h-auto flex-wrap justify-start">
          {groups.map((group) => (
            <TabsTrigger key={group.id} value={group.id} className="gap-2">
              <span className="font-mono text-xs">{group.id}</span>
              {group.queue.partyCount > 0 ? (
                <Badge variant="secondary" className="tabular">
                  {formatNumber(group.queue.partyCount)}
                </Badge>
              ) : null}
            </TabsTrigger>
          ))}
        </TabsList>

        {groups.map((group) => (
          <TabsContent key={group.id} value={group.id}>
            {group.id === activeGroup.id ? <QueuePanel group={group} /> : null}
          </TabsContent>
        ))}
      </Tabs>
    </>
  );
}

export default function QueuesPage() {
  return (
    <>
      <PageHeader
        title="Matchmaking queues"
        description="Parties waiting for a match, how long they have been waiting, and whether the warm pool can absorb them."
      />
      <ClusterGate>
        {(snapshot) => <QueuesView snapshot={snapshot} />}
      </ClusterGate>
    </>
  );
}
