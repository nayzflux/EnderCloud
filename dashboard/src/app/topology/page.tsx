"use client";

import { NetworkIcon } from "lucide-react";
import dynamic from "next/dynamic";
import { useMemo, useState } from "react";
import { ClusterGate } from "@/components/cluster-gate";
import { FilterBar, FilterSelect, SearchField } from "@/components/filter-bar";
import { PageHeader } from "@/components/page-header";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { buildClusterFlow } from "@/lib/cluster-flow";
import type { DashboardClusterSnapshot } from "@/lib/contracts";
import { instanceFilters, type InstanceFilter } from "@/lib/status";
import { cn } from "@/lib/utils";

// React Flow measures the DOM, so it can only render on the client.
const ClusterFlow = dynamic(
  () =>
    import("@/components/topology/cluster-flow").then(
      (module) => module.ClusterFlow,
    ),
  { ssr: false, loading: () => <Skeleton className="size-full" /> },
);

const stateLegend = [
  { label: "Running", className: "bg-success" },
  { label: "Starting", className: "bg-info" },
  { label: "Draining", className: "bg-warning" },
  { label: "Failed", className: "bg-destructive" },
] as const;

function EdgeSample({ dashed }: { readonly dashed?: boolean }) {
  return (
    <svg
      aria-hidden
      width="30"
      height="8"
      viewBox="0 0 30 8"
      className="shrink-0 text-muted-foreground"
    >
      <line
        x1="0"
        y1="4"
        x2="22"
        y2="4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeDasharray={dashed ? "5 5" : undefined}
      />
      <polygon points="22,1 29,4 22,7" fill="currentColor" />
    </svg>
  );
}

function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border px-3 py-2 text-xs text-muted-foreground">
      <span className="font-medium text-foreground">
        Queue → warm pool → instance → session
      </span>
      <span className="flex items-center gap-2">
        <EdgeSample />
        established link
      </span>
      <span className="flex items-center gap-2">
        <EdgeSample dashed />
        waiting for an instance
      </span>
      <span className="ml-auto flex flex-wrap items-center gap-3">
        {stateLegend.map((item) => (
          <span key={item.label} className="flex items-center gap-1.5">
            <span
              aria-hidden
              className={cn("size-1.5 rounded-full", item.className)}
            />
            {item.label}
          </span>
        ))}
      </span>
    </div>
  );
}

function TopologyView({
  snapshot,
}: {
  readonly snapshot: DashboardClusterSnapshot;
}) {
  const [search, setSearch] = useState("");
  const [groupId, setGroupId] = useState("all");
  const [state, setState] = useState<InstanceFilter>("all");

  const model = useMemo(
    () => buildClusterFlow(snapshot, { groupId, state, search }),
    [snapshot, groupId, state, search],
  );

  return (
    <>
      <FilterBar>
        <SearchField
          value={search}
          onChange={setSearch}
          label="Search the topology"
          placeholder="Instance, variant, session…"
        />
        <FilterSelect
          label="Filter by group"
          value={groupId}
          onChange={setGroupId}
          options={[
            { value: "all", label: "All groups" },
            ...snapshot.groups.map((group) => ({
              value: group.id,
              label: group.id,
            })),
          ]}
        />
        <FilterSelect
          label="Filter by state"
          value={state}
          onChange={(value) => setState(value as InstanceFilter)}
          options={instanceFilters.map((filter) => ({
            value: filter.value,
            label: filter.label,
          }))}
        />
      </FilterBar>

      <Legend />

      <div className="relative h-[calc(100svh-19rem)] min-h-[32rem] w-full overflow-hidden rounded-xl bg-muted/30 ring-1 ring-border">
        {model.nodes.length > 0 ? (
          <ClusterFlow model={model} />
        ) : (
          <Empty className="h-full">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <NetworkIcon />
              </EmptyMedia>
              <EmptyTitle>Nothing to draw</EmptyTitle>
              <EmptyDescription>
                No group matches the current filters. Clear the search or widen
                the state filter.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </div>
    </>
  );
}

export default function TopologyPage() {
  return (
    <>
      <PageHeader
        title="Topology"
        description="How every group wires its queue and warm pool to the instances, and which session runs on each of them."
      />
      <ClusterGate
        skeleton={<Skeleton className="h-[70svh] w-full rounded-xl" />}
      >
        {(snapshot) => <TopologyView snapshot={snapshot} />}
      </ClusterGate>
    </>
  );
}
