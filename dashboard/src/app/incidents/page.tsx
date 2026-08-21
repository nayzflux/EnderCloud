"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  CircleAlertIcon,
  HistoryIcon,
} from "lucide-react";
import { useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState } from "react";
import { FilterBar, FilterSelect, SearchField } from "@/components/filter-bar";
import { RelativeTime } from "@/components/live-time";
import { KeyValue, KeyValueGrid, PageHeader, SectionTitle } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { fetchIncidents } from "@/lib/api";
import {
  incidentKinds,
  type DashboardIncident,
  type IncidentKind,
  type IncidentSeverity,
} from "@/lib/contracts";
import { formatDateTime, humanizeState } from "@/lib/format";

type StatusFilter = "active" | "resolved";
type SeverityFilter = "all" | IncidentSeverity;
type KindFilter = "all" | IncidentKind;

const severityOptions = [
  { value: "all", label: "All severities" },
  { value: "CRITICAL", label: "Critical" },
  { value: "WARNING", label: "Warning" },
] as const;

const kindOptions = [
  { value: "all", label: "All incident types" },
  ...incidentKinds.map((kind) => ({ value: kind, label: humanizeState(kind) })),
];

const recommendations: Readonly<Record<string, string>> = {
  NO_ONLINE_HOST: "Bring an execution host online and verify that its heartbeat reaches the orchestrator.",
  INSUFFICIENT_CPU: "Increase the CPU announced by an online host, reduce existing reservations, or add a host.",
  INSUFFICIENT_MEMORY: "Increase allocatable memory, reduce existing reservations, or add a host.",
  INSUFFICIENT_RESOURCES: "Review both CPU and memory reservations across online hosts.",
  GROUP_MAXIMUM_REACHED: "Review the group maximum and the instances already counted toward it.",
  PLACEMENT_CONFLICT: "Inspect host placement constraints and the requested variant resources.",
  STARTUP_TIMEOUT: "Inspect the affected variant logs and confirm that its readiness signal is emitted.",
  CREATE_FAILED: "Inspect the affected variant and execution-host logs for container creation errors.",
  HOST_OFFLINE: "Restore the host agent or move capacity to another online host.",
  HOST_RECOVERING: "Inspect the host agent and its last control error before reactivating it.",
  REPLACEMENT_UNAVAILABLE: "Ensure another host has enough free resources for the draining instances.",
  REPLACEMENT_NOT_CREATED: "Ensure another host has enough free resources for the draining instances.",
  RETRIES_EXHAUSTED: "Inspect the session and its instance startup failures before retrying matchmaking.",
  MAX_INSTANCE_RETRIES_REACHED: "Inspect the session and its instance startup failures before retrying matchmaking.",
  TRANSFER_EXPIRED: "Inspect proxy connectivity and the affected player transfer records.",
  TRANSFER_COMMAND_EXPIRED: "Inspect proxy connectivity and the affected player transfer records.",
  COMMAND_FAILED: "Inspect the persistent command error and the target agent logs.",
  CREATE_COMMAND_FAILED: "Inspect the persistent create command error and the target agent logs.",
  DELETE_COMMAND_FAILED: "Inspect the persistent delete command error and the target agent logs.",
  SCHEDULED_TASK_FAILED: "Inspect orchestrator logs for the named control loop and its latest exception.",
};

function IncidentBadge({ incident }: { readonly incident: DashboardIncident }) {
  return (
    <StatusBadge
      tone={incident.severity === "CRITICAL" ? "danger" : "warning"}
      label={humanizeState(incident.severity)}
    />
  );
}

function IncidentDetail({
  incident,
  onClose,
}: {
  readonly incident: DashboardIncident | null;
  readonly onClose: () => void;
}) {
  const recommendation = incident ? recommendations[incident.cause] : undefined;
  return (
    <Sheet open={incident !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent side="right" className="gap-0 p-0 data-[side=right]:w-full sm:max-w-2xl!">
        {incident ? (
          <>
            <SheetHeader className="gap-3 border-b p-4 pr-12">
              <div className="flex items-start gap-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
                  {incident.status === "RESOLVED" ? <CheckCircle2Icon className="size-4" /> : <AlertTriangleIcon className="size-4" />}
                </span>
                <div className="min-w-0">
                  <SheetTitle>{incident.summary}</SheetTitle>
                  <SheetDescription className="font-mono text-xs">
                    {incident.id}
                  </SheetDescription>
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5">
                <IncidentBadge incident={incident} />
                <StatusBadge
                  tone={incident.status === "ACTIVE" ? "danger" : "success"}
                  label={humanizeState(incident.status)}
                />
                <StatusBadge tone="neutral" label={humanizeState(incident.kind)} dot={false} />
              </div>
            </SheetHeader>
            <ScrollArea className="min-h-0 flex-1">
              <div className="space-y-6 p-4">
                {recommendation ? (
                  <Alert>
                    <CircleAlertIcon />
                    <AlertTitle>Recommended investigation</AlertTitle>
                    <AlertDescription>{recommendation}</AlertDescription>
                  </Alert>
                ) : null}

                <section className="space-y-3">
                  <SectionTitle>Diagnosis</SectionTitle>
                  <KeyValueGrid>
                    <KeyValue label="Cause" mono>{incident.cause}</KeyValue>
                    <KeyValue label="Occurrences">{incident.occurrenceCount}</KeyValue>
                    <KeyValue label="Scope type">{humanizeState(incident.scope.type)}</KeyValue>
                    <KeyValue label="Scope identifier" mono>{incident.scope.id}</KeyValue>
                    <KeyValue label="Group" mono>{incident.scope.groupId ?? "—"}</KeyValue>
                    <KeyValue label="Variant" mono>{incident.scope.variantId ?? "—"}</KeyValue>
                  </KeyValueGrid>
                </section>

                <Separator />
                <section className="space-y-3">
                  <SectionTitle>Timeline</SectionTitle>
                  <KeyValueGrid>
                    <KeyValue label="First observed">{formatDateTime(incident.firstObservedAt)}</KeyValue>
                    <KeyValue label="Last observed">{formatDateTime(incident.lastObservedAt)}</KeyValue>
                    <KeyValue label="Opened">{formatDateTime(incident.openedAt)}</KeyValue>
                    <KeyValue label="Resolved">{formatDateTime(incident.resolvedAt)}</KeyValue>
                  </KeyValueGrid>
                </section>

                <Separator />
                <section className="space-y-3">
                  <SectionTitle>Evidence</SectionTitle>
                  <pre className="overflow-x-auto rounded-lg border bg-muted/40 p-3 font-mono text-xs leading-5 whitespace-pre-wrap wrap-break-word">
                    {JSON.stringify(incident.evidence, null, 2)}
                  </pre>
                </section>
              </div>
            </ScrollArea>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function IncidentsContent() {
  const searchParams = useSearchParams();
  const initialStatus = searchParams.get("status") === "resolved" ? "resolved" : "active";
  const [status, setStatus] = useState<StatusFilter>(initialStatus);
  const [severity, setSeverity] = useState<SeverityFilter>("all");
  const [kind, setKind] = useState<KindFilter>("all");
  const [groupId, setGroupId] = useState(searchParams.get("groupId") ?? "");
  const scopeId = searchParams.get("scopeId") ?? undefined;
  const [selected, setSelected] = useState<DashboardIncident | null>(null);

  const query = useInfiniteQuery({
    queryKey: ["incidents", status, severity, kind, groupId, scopeId],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => fetchIncidents({
      status,
      ...(severity === "all" ? {} : { severity }),
      ...(kind === "all" ? {} : { kind }),
      ...(groupId.trim() ? { groupId: groupId.trim() } : {}),
      ...(scopeId ? { scopeId } : {}),
      ...(pageParam ? { cursor: pageParam } : {}),
      limit: 50,
    }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });

  const incidents = useMemo(
    () => query.data?.pages.flatMap((page) => page.incidents) ?? [],
    [query.data],
  );
  const counts = query.data?.pages[0];

  return (
    <>
      <PageHeader
        title="Operational incidents"
        description="Persistent diagnoses for blocked capacity, repeated failures and unhealthy control loops. Performance alerts remain in Monitoring."
      />

      <div className="grid divide-y rounded-lg border sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        <div className="px-4 py-3">
          <p className="text-xs text-muted-foreground">Active</p>
          <p className="font-heading text-xl font-semibold tabular">{counts?.activeCount ?? "—"}</p>
        </div>
        <div className="px-4 py-3">
          <p className="text-xs text-muted-foreground">Critical</p>
          <p className="font-heading text-xl font-semibold tabular">{counts?.criticalCount ?? "—"}</p>
        </div>
        <div className="px-4 py-3">
          <p className="text-xs text-muted-foreground">Current view</p>
          <p className="font-heading text-xl font-semibold tabular">{incidents.length}</p>
        </div>
      </div>

      <div className="space-y-3">
        <Tabs value={status} onValueChange={(value) => setStatus(value as StatusFilter)}>
          <TabsList variant="line">
            <TabsTrigger value="active">Active</TabsTrigger>
            <TabsTrigger value="resolved"><HistoryIcon /> Resolved</TabsTrigger>
          </TabsList>
        </Tabs>
        <FilterBar>
          <FilterSelect
            value={severity}
            onChange={(value) => setSeverity(value as SeverityFilter)}
            options={severityOptions}
            label="Filter by severity"
          />
          <FilterSelect
            value={kind}
            onChange={(value) => setKind(value as KindFilter)}
            options={kindOptions}
            label="Filter by incident type"
            className="w-56"
          />
          <SearchField
            value={groupId}
            onChange={setGroupId}
            label="Filter by exact group identifier"
            placeholder="Exact group id…"
          />
          {scopeId ? (
            <span className="rounded-md border px-2.5 py-1.5 font-mono text-xs text-muted-foreground">
              Scope: {scopeId}
            </span>
          ) : null}
        </FilterBar>
      </div>

      {query.isError ? (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>Incidents unavailable</AlertTitle>
          <AlertDescription>The persistent incident registry could not be refreshed.</AlertDescription>
        </Alert>
      ) : null}

      {query.isPending ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }, (_unused, index) => <Skeleton key={index} className="h-14 w-full" />)}
        </div>
      ) : null}

      {!query.isPending && !query.isError && incidents.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon"><CheckCircle2Icon /></EmptyMedia>
            <EmptyTitle>{status === "active" ? "No active operational incident" : "No resolved incident found"}</EmptyTitle>
            <EmptyDescription>
              {status === "active"
                ? "Transient anomalies below their threshold stay invisible and are discarded after recovery."
                : "Change the filters to inspect the retained 90-day history."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}

      {incidents.length > 0 ? (
        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Severity</TableHead>
                <TableHead>Incident</TableHead>
                <TableHead>Scope</TableHead>
                <TableHead>Cause</TableHead>
                <TableHead className="text-right">Count</TableHead>
                <TableHead>Last observed</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {incidents.map((incident) => (
                <TableRow key={incident.id}>
                  <TableCell><IncidentBadge incident={incident} /></TableCell>
                  <TableCell className="max-w-sm">
                    <button
                      type="button"
                      className="text-left font-medium hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => setSelected(incident)}
                    >
                      {incident.summary}
                    </button>
                    <p className="mt-1 font-mono text-xs text-muted-foreground">{humanizeState(incident.kind)}</p>
                  </TableCell>
                  <TableCell>
                    <span className="font-mono text-xs">{incident.scope.id}</span>
                    <p className="text-xs text-muted-foreground">{humanizeState(incident.scope.type)}</p>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{incident.cause}</TableCell>
                  <TableCell className="text-right font-mono tabular">{incident.occurrenceCount}</TableCell>
                  <TableCell><RelativeTime value={incident.lastObservedAt} /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : null}

      {query.hasNextPage ? (
        <div className="flex justify-center">
          <Button variant="outline" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
            {query.isFetchingNextPage ? "Loading…" : "Load older incidents"}
          </Button>
        </div>
      ) : null}

      <IncidentDetail incident={selected} onClose={() => setSelected(null)} />
    </>
  );
}

export default function IncidentsPage() {
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full" />}>
      <IncidentsContent />
    </Suspense>
  );
}
