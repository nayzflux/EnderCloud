"use client";

import { ServerIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { ClusterGate } from "@/components/cluster-gate";
import { CopyableId } from "@/components/copyable-id";
import { DataTable, type Column } from "@/components/data-table";
import { useDetailPanel } from "@/components/detail-panel";
import {
  FilterBar,
  FilterSelect,
  ResultCount,
  SearchField,
} from "@/components/filter-bar";
import { PageHeader } from "@/components/page-header";
import { AvailabilityBadge, LifecycleBadge } from "@/components/status-badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import type { DashboardGroup, DashboardInstance } from "@/lib/contracts";
import { Elapsed } from "@/components/live-time";
import { ratio } from "@/lib/format";
import {
  instanceFilters,
  matchesInstanceFilter,
  type InstanceFilter,
} from "@/lib/status";

interface Row {
  readonly group: DashboardGroup;
  readonly instance: DashboardInstance;
}

function OccupancyCell({ instance }: { readonly instance: DashboardInstance }) {
  const percent = ratio(instance.playerCount, instance.maximumPlayers);
  return (
    <div className="flex w-28 items-center gap-2">
      <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-foreground/60"
          style={{ width: `${percent}%` }}
        />
      </div>
      <span className="shrink-0 font-mono text-xs text-muted-foreground tabular">
        {instance.playerCount}/{instance.maximumPlayers}
      </span>
    </div>
  );
}

export default function InstancesPage() {
  const { openInstance } = useDetailPanel();
  const [search, setSearch] = useState("");
  const [groupId, setGroupId] = useState("all");
  const [state, setState] = useState<InstanceFilter>("all");

  const columns = useMemo<readonly Column<Row>[]>(
    () => [
      {
        id: "id",
        header: "Instance",
        cell: ({ instance }) => (
          <CopyableId value={instance.id} label="instance id" />
        ),
        sortValue: ({ instance }) => instance.id,
      },
      {
        id: "group",
        header: "Group",
        cell: ({ group }) => (
          <span className="font-mono text-xs">{group.id}</span>
        ),
        sortValue: ({ group }) => group.id,
      },
      {
        id: "variant",
        header: "Variant",
        hideOnMobile: true,
        cell: ({ instance }) => (
          <span className="font-mono text-xs text-muted-foreground">
            {instance.variantId}
          </span>
        ),
        sortValue: ({ instance }) => instance.variantId,
      },
      {
        id: "lifecycle",
        header: "Lifecycle",
        cell: ({ instance }) => (
          <LifecycleBadge state={instance.lifecycleState} />
        ),
        sortValue: ({ instance }) => instance.lifecycleState,
      },
      {
        id: "availability",
        header: "Availability",
        hideOnMobile: true,
        cell: ({ instance }) => (
          <AvailabilityBadge state={instance.availabilityState} />
        ),
        sortValue: ({ instance }) => instance.availabilityState,
      },
      {
        id: "players",
        header: "Players",
        cell: ({ instance }) => <OccupancyCell instance={instance} />,
        sortValue: ({ instance }) => instance.playerCount,
      },
      {
        id: "endpoint",
        header: "Endpoint",
        hideOnMobile: true,
        cell: ({ instance }) => (
          <span className="font-mono text-xs text-muted-foreground">
            {instance.endpoint ?? "—"}
          </span>
        ),
        sortValue: ({ instance }) => instance.endpoint ?? "",
      },
      {
        id: "age",
        header: "Age",
        align: "right",
        cell: ({ instance }) => (
          <Elapsed
            value={instance.createdAt}
            className="font-mono text-xs text-muted-foreground tabular"
          />
        ),
        sortValue: ({ instance }) => Date.parse(instance.createdAt),
      },
    ],
    [],
  );

  return (
    <>
      <PageHeader
        title="Instances"
        description="Every managed Minecraft container, its lifecycle state and its current occupancy."
      />
      <ClusterGate>
        {(snapshot) => {
        const allRows: Row[] = snapshot.groups.flatMap((group) =>
          group.instances.map((instance) => ({ group, instance })),
        );

        const needle = search.trim().toLowerCase();
        const rows = allRows.filter(({ group, instance }) => {
          if (groupId !== "all" && group.id !== groupId) return false;
          if (!matchesInstanceFilter(instance, state)) return false;
          if (!needle) return true;
          return [
            instance.id,
            instance.variantId,
            instance.endpoint ?? "",
            instance.sessionId ?? "",
            group.id,
          ].some((value) => value.toLowerCase().includes(needle));
        });

        return (
          <>
            <FilterBar>
              <SearchField
                value={search}
                onChange={setSearch}
                label="Search instances"
                placeholder="Instance, variant, endpoint, session…"
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
              <ResultCount
                shown={rows.length}
                total={allRows.length}
                noun="instance"
              />
            </FilterBar>

            <Card className="py-0">
              <CardContent className="px-0 py-2">
                <DataTable
                  rows={rows}
                  columns={columns}
                  getRowId={(row) => row.instance.id}
                  onRowClick={(row) => openInstance(row.instance.id)}
                  initialSort={{ columnId: "age", desc: true }}
                  caption="Cluster instances"
                  emptyState={
                    <Empty className="py-12">
                      <EmptyHeader>
                        <EmptyMedia variant="icon">
                          <ServerIcon />
                        </EmptyMedia>
                        <EmptyTitle>No instance yet</EmptyTitle>
                        <EmptyDescription>
                          Groups scale up on demand — instances appear here as
                          soon as the orchestrator creates them.
                        </EmptyDescription>
                      </EmptyHeader>
                    </Empty>
                  }
                />
              </CardContent>
            </Card>
            </>
          );
        }}
      </ClusterGate>
    </>
  );
}
