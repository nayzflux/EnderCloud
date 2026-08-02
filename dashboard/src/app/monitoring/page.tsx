"use client";

import { useQuery } from "@tanstack/react-query";
import { ActivityIcon, CircleAlertIcon, GaugeIcon, TimerResetIcon } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  XAxis,
  YAxis,
  type TooltipContentProps,
} from "recharts";
import { useCluster } from "@/components/cluster-provider";
import { FilterBar, FilterSelect } from "@/components/filter-bar";
import { PageHeader } from "@/components/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { fetchGroupMonitoring } from "@/lib/api";
import type { MonitoringRange } from "@/lib/contracts";
import {
  buildStartupChartRows,
  buildTpsChartRows,
  buildVariantChartConfig,
  sampleKey,
  type StartupMetric,
  type TpsMetric,
} from "@/lib/monitoring-charts";

const rangeOptions: readonly { readonly value: MonitoringRange; readonly label: string }[] = [
  { value: "1h", label: "1h" },
  { value: "6h", label: "6h" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
];

const startupOptions: readonly { readonly value: StartupMetric; readonly label: string }[] = [
  { value: "totalAverageMs", label: "Total readiness" },
  { value: "bootAverageMs", label: "Minecraft boot" },
];

const tpsOptions: readonly { readonly value: TpsMetric; readonly label: string }[] = [
  { value: "oneMinute", label: "1m" },
  { value: "fiveMinutes", label: "5m" },
  { value: "fifteenMinutes", label: "15m" },
];

function SingleToggle<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  readonly label: string;
  readonly value: T;
  readonly onChange: (value: T) => void;
  readonly options: readonly { readonly value: T; readonly label: string }[];
}) {
  return (
    <ToggleGroup
      aria-label={label}
      variant="outline"
      size="sm"
      spacing={0}
      value={[value]}
      onValueChange={(next) => {
        const selected = next[0];
        if (selected) onChange(selected as T);
      }}
    >
      {options.map((option) => (
        <ToggleGroupItem key={option.value} value={option.value}>
          {option.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

function formatAxisTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function MetricTooltip({
  unit,
  active,
  payload,
  label,
}: TooltipContentProps & { readonly unit: "ms" | "TPS" }) {
  return (
    <ChartTooltipContent
      active={active}
      payload={payload}
      label={label}
      indicator="line"
      labelFormatter={(label) => formatAxisTime(String(label))}
      formatter={(value, name, item) => {
        const numeric = Number(value);
        const samples = Number(item.payload?.[sampleKey(String(name))] ?? 0);
        return (
          <div className="flex w-full items-center justify-between gap-4">
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="truncate text-muted-foreground">{String(name)}</span>
              <span className="text-[0.65rem] text-muted-foreground">
                {samples} sample{samples === 1 ? "" : "s"}
              </span>
            </div>
            <span className="font-mono font-medium tabular-nums">
              {unit === "ms" ? `${(numeric / 1_000).toFixed(1)}s` : numeric.toFixed(2)}
            </span>
          </div>
        );
      }}
    />
  );
}

function ChartEmpty({ kind }: { readonly kind: "startup" | "TPS" }) {
  return (
    <Empty className="h-80">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          {kind === "startup" ? <TimerResetIcon /> : <GaugeIcon />}
        </EmptyMedia>
        <EmptyTitle>No {kind} samples yet</EmptyTitle>
        <EmptyDescription>
          {kind === "startup"
            ? "The chart will populate after a server reaches RUNNING in this range."
            : "TPS appears after an updated Paper bridge sends its first heartbeat."}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function MetricCard({
  title,
  description,
  action,
  children,
}: {
  readonly title: string;
  readonly description: string;
  readonly action: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <Card className="gap-0">
      <CardHeader className="border-b pb-4">
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
        <CardAction>{action}</CardAction>
      </CardHeader>
      <CardContent className="pt-5">{children}</CardContent>
    </Card>
  );
}

export default function MonitoringPage() {
  const { snapshot, isPending: clusterPending, refreshInterval } = useCluster();
  const defaultGroupId =
    snapshot?.groups.find((group) => group.enabled)?.id ?? snapshot?.groups[0]?.id ?? "";
  const [selectedGroupId, setSelectedGroupId] = useState("");
  const [range, setRange] = useState<MonitoringRange>("24h");
  const [startupMetric, setStartupMetric] = useState<StartupMetric>("totalAverageMs");
  const [tpsMetric, setTpsMetric] = useState<TpsMetric>("fiveMinutes");
  const groupId = selectedGroupId || defaultGroupId;

  const query = useQuery({
    queryKey: ["monitoring", groupId, range],
    queryFn: () => fetchGroupMonitoring(groupId, range),
    enabled: groupId.length > 0,
    refetchInterval:
      refreshInterval === 0 ? false : Math.max(30_000, refreshInterval),
    refetchIntervalInBackground: false,
    placeholderData: (previous) => previous,
  });

  const chartConfig = useMemo(
    () => buildVariantChartConfig(query.data?.variants ?? []),
    [query.data?.variants],
  );
  const startupRows = useMemo(
    () => buildStartupChartRows(query.data?.variants ?? [], startupMetric),
    [query.data?.variants, startupMetric],
  );
  const tpsRows = useMemo(
    () => buildTpsChartRows(query.data?.variants ?? [], tpsMetric),
    [query.data?.variants, tpsMetric],
  );

  return (
    <>
      <PageHeader
        title="Performance monitoring"
        description="Rolling startup latency and server tick health, grouped by deployable variant."
        actions={
          <SingleToggle
            label="Monitoring range"
            value={range}
            onChange={setRange}
            options={rangeOptions}
          />
        }
      />

      {snapshot ? (
        <FilterBar>
          <FilterSelect
            label="Filter by group"
            value={groupId}
            onChange={setSelectedGroupId}
            options={snapshot.groups.map((group) => ({
              value: group.id,
              label: group.id,
            }))}
          />
          <p className="text-xs text-muted-foreground">
            60-minute startup window · metrics refresh every 30 seconds
          </p>
        </FilterBar>
      ) : null}

      {query.isError ? (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>Monitoring unavailable</AlertTitle>
          <AlertDescription>{query.error.message}</AlertDescription>
        </Alert>
      ) : null}

      {query.data ? (
        <div className="flex flex-col gap-4">
          <MetricCard
            title="Startup latency"
            description="Successful starts averaged over the preceding 60 minutes."
            action={
              <SingleToggle
                label="Startup duration"
                value={startupMetric}
                onChange={setStartupMetric}
                options={startupOptions}
              />
            }
          >
            {startupRows.length === 0 ? (
              <ChartEmpty kind="startup" />
            ) : (
              <ChartContainer config={chartConfig} className="h-80 w-full">
                <LineChart data={startupRows} accessibilityLayer margin={{ left: 4, right: 16 }}>
                  <CartesianGrid vertical={false} strokeDasharray="3 3" />
                  <XAxis
                    dataKey="at"
                    tickLine={false}
                    axisLine={false}
                    minTickGap={42}
                    tickFormatter={formatAxisTime}
                  />
                  <YAxis
                    tickLine={false}
                    axisLine={false}
                    width={44}
                    tickFormatter={(value) => `${Math.round(Number(value) / 1_000)}s`}
                  />
                  <ChartTooltip
                    trigger="hover"
                    cursor={{
                      stroke: "var(--color-blue-500)",
                      strokeDasharray: "4 4",
                      strokeOpacity: 0.35,
                    }}
                    content={(props) => <MetricTooltip {...props} unit="ms" />}
                  />
                  <ChartLegend content={<ChartLegendContent />} />
                  {startupMetric === "bootAverageMs" ? (
                    <ReferenceLine
                      y={query.data.thresholds.startupBootMs}
                      stroke="var(--warning)"
                      strokeDasharray="5 4"
                      ifOverflow="extendDomain"
                      label={{ value: "alert", position: "insideTopRight" }}
                    />
                  ) : null}
                  {query.data.variants.map((variant) => (
                    <Line
                      key={variant.variantId}
                      type="monotone"
                      dataKey={variant.variantId}
                      stroke={`var(--color-${variant.variantId})`}
                      strokeWidth={2}
                      dot={false}
                      activeDot={{
                        fill: "var(--color-blue-500)",
                        r: 4,
                        stroke: "var(--background)",
                        strokeWidth: 2,
                      }}
                      connectNulls={false}
                    />
                  ))}
                </LineChart>
              </ChartContainer>
            )}
          </MetricCard>

          <MetricCard
            title="Server TPS"
            description="Paper rolling averages combined across active heartbeat samples."
            action={
              <SingleToggle
                label="TPS rolling window"
                value={tpsMetric}
                onChange={setTpsMetric}
                options={tpsOptions}
              />
            }
          >
            {tpsRows.length === 0 ? (
              <ChartEmpty kind="TPS" />
            ) : (
              <ChartContainer config={chartConfig} className="h-80 w-full">
                <LineChart data={tpsRows} accessibilityLayer margin={{ left: 4, right: 16 }}>
                  <CartesianGrid vertical={false} strokeDasharray="3 3" />
                  <XAxis
                    dataKey="at"
                    tickLine={false}
                    axisLine={false}
                    minTickGap={42}
                    tickFormatter={formatAxisTime}
                  />
                  <YAxis
                    domain={["auto", 20]}
                    tickLine={false}
                    axisLine={false}
                    width={36}
                    tickFormatter={(value) => Number(value).toFixed(1)}
                  />
                  <ReferenceLine
                    y={query.data.thresholds.tps}
                    stroke="var(--warning)"
                    strokeDasharray="5 4"
                    ifOverflow="extendDomain"
                    label={{ value: "19 TPS", position: "insideTopRight" }}
                  />
                  <ChartTooltip
                    trigger="hover"
                    cursor={{
                      stroke: "var(--color-blue-500)",
                      strokeDasharray: "4 4",
                      strokeOpacity: 0.35,
                    }}
                    content={(props) => <MetricTooltip {...props} unit="TPS" />}
                  />
                  <ChartLegend content={<ChartLegendContent />} />
                  {query.data.variants.map((variant) => (
                    <Line
                      key={variant.variantId}
                      type="monotone"
                      dataKey={variant.variantId}
                      stroke={`var(--color-${variant.variantId})`}
                      strokeWidth={2}
                      dot={false}
                      activeDot={{
                        fill: "var(--color-blue-500)",
                        r: 4,
                        stroke: "var(--background)",
                        strokeWidth: 2,
                      }}
                      connectNulls={false}
                    />
                  ))}
                </LineChart>
              </ChartContainer>
            )}
          </MetricCard>
        </div>
      ) : null}

      {!query.data && (query.isPending || clusterPending) ? (
        <div className="flex flex-col gap-4">
          <Skeleton className="h-96 w-full rounded-xl" />
          <Skeleton className="h-96 w-full rounded-xl" />
        </div>
      ) : null}

      {!clusterPending && snapshot?.groups.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ActivityIcon />
            </EmptyMedia>
            <EmptyTitle>No groups configured</EmptyTitle>
            <EmptyDescription>Add a server group before collecting performance metrics.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}
    </>
  );
}
