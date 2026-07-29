"use client";

import { Gamepad2Icon } from "lucide-react";
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
import { SessionStateBadge } from "@/components/status-badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import type { DashboardGroup, DashboardSession } from "@/lib/contracts";
import { formatAge, formatCountdown } from "@/lib/format";

interface Row {
  readonly group: DashboardGroup;
  readonly session: DashboardSession;
}

const stateFilters = [
  { value: "all", label: "All states" },
  { value: "active", label: "Active" },
  { value: "waiting", label: "Waiting" },
  { value: "terminal", label: "Finished" },
] as const;

type StateFilter = (typeof stateFilters)[number]["value"];

function matchesStateFilter(
  session: DashboardSession,
  filter: StateFilter,
): boolean {
  switch (filter) {
    case "active":
      return (
        session.state === "RUNNING" ||
        session.state === "STARTING" ||
        session.state === "TRANSFERRING"
      );
    case "waiting":
      return (
        session.state === "FORMING" ||
        session.state === "WAITING" ||
        session.state === "WAITING_FOR_INSTANCE"
      );
    case "terminal":
      return (
        session.state === "FINISHED" ||
        session.state === "CANCELLED" ||
        session.state === "FAILED"
      );
    case "all":
      return true;
  }
}

export default function SessionsPage() {
  const { openSession, openInstance } = useDetailPanel();
  const [search, setSearch] = useState("");
  const [groupId, setGroupId] = useState("all");
  const [state, setState] = useState<StateFilter>("all");

  const columns = useMemo<readonly Column<Row>[]>(
    () => [
      {
        id: "id",
        header: "Session",
        cell: ({ session }) => (
          <CopyableId value={session.id} label="session id" />
        ),
        sortValue: ({ session }) => session.id,
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
        id: "state",
        header: "State",
        cell: ({ session }) => <SessionStateBadge state={session.state} />,
        sortValue: ({ session }) => session.state,
      },
      {
        id: "instance",
        header: "Instance",
        hideOnMobile: true,
        cell: ({ session }) =>
          session.instanceId ? (
            <button
              type="button"
              className="font-mono text-xs underline underline-offset-4 hover:text-primary"
              onClick={(event) => {
                event.stopPropagation();
                openInstance(session.instanceId as string);
              }}
            >
              {session.instanceId}
            </button>
          ) : (
            <span className="text-xs text-muted-foreground">Unassigned</span>
          ),
        sortValue: ({ session }) => session.instanceId ?? "",
      },
      {
        id: "sessionPlayers",
        header: "Session players",
        cell: ({ session }) => (
          <span
            className="font-mono text-xs tabular"
            title="Players currently belonging to the session / maximum players allowed"
          >
            {session.activePlayerCount}
            <span className="text-muted-foreground">
              /{session.maximumPlayerCount}
            </span>
          </span>
        ),
        sortValue: ({ session }) => session.activePlayerCount,
      },
      {
        id: "transferredPlayers",
        header: "Transferred",
        cell: ({ session }) => (
          <span
            className="font-mono text-xs tabular"
            title="Players connected to the assigned server / players currently in the session"
          >
            {session.connectedPlayerCount}
            <span className="text-muted-foreground">
              /{session.activePlayerCount}
            </span>
          </span>
        ),
        sortValue: ({ session }) => session.connectedPlayerCount,
      },
      {
        id: "teams",
        header: "Teams",
        hideOnMobile: true,
        align: "right",
        cell: ({ session }) => (
          <span className="font-mono text-xs text-muted-foreground tabular">
            {session.teamCount}
          </span>
        ),
        sortValue: ({ session }) => session.teamCount,
      },
      {
        id: "deadline",
        header: "Deadline",
        hideOnMobile: true,
        align: "right",
        cell: ({ session }) => (
          <span className="font-mono text-xs text-muted-foreground tabular">
            {session.waitingDeadline
              ? formatCountdown(session.waitingDeadline)
              : "Not eligible"}
          </span>
        ),
        sortValue: ({ session }) =>
          session.waitingDeadline ? Date.parse(session.waitingDeadline) : Number.MAX_SAFE_INTEGER,
      },
      {
        id: "age",
        header: "Age",
        align: "right",
        cell: ({ session }) => (
          <span className="font-mono text-xs text-muted-foreground tabular">
            {formatAge(session.createdAt)}
          </span>
        ),
        sortValue: ({ session }) => Date.parse(session.createdAt),
      },
    ],
    [openInstance],
  );

  return (
    <>
      <PageHeader
        title="Sessions"
        description="Matches formed by the matchmaker, showing session occupancy separately from players transferred to the assigned server."
      />
      <ClusterGate>
        {(snapshot) => {
        const allRows: Row[] = snapshot.groups.flatMap((group) =>
          group.sessions.map((session) => ({ group, session })),
        );

        const needle = search.trim().toLowerCase();
        const rows = allRows.filter(({ group, session }) => {
          if (groupId !== "all" && group.id !== groupId) return false;
          if (!matchesStateFilter(session, state)) return false;
          if (!needle) return true;
          return [
            session.id,
            session.instanceId ?? "",
            session.state,
            group.id,
          ].some((value) => value.toLowerCase().includes(needle));
        });

        return (
          <>
            <FilterBar>
              <SearchField
                value={search}
                onChange={setSearch}
                label="Search sessions"
                placeholder="Session, instance, state…"
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
                onChange={(value) => setState(value as StateFilter)}
                options={stateFilters.map((filter) => ({ ...filter }))}
              />
              <ResultCount
                shown={rows.length}
                total={allRows.length}
                noun="session"
              />
            </FilterBar>

            <Card className="py-0">
              <CardContent className="px-0 py-2">
                <DataTable
                  rows={rows}
                  columns={columns}
                  getRowId={(row) => row.session.id}
                  onRowClick={(row) => openSession(row.session.id)}
                  initialSort={{ columnId: "age", desc: true }}
                  caption="Cluster sessions"
                  emptyState={
                    <Empty className="py-12">
                      <EmptyHeader>
                        <EmptyMedia variant="icon">
                          <Gamepad2Icon />
                        </EmptyMedia>
                        <EmptyTitle>No session in flight</EmptyTitle>
                        <EmptyDescription>
                          Sessions appear as soon as the matchmaker forms a match
                          from the queues.
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
