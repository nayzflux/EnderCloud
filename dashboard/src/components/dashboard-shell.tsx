"use client";

import { useQuery } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import {
  ActivityIcon,
  BoxIcon,
  BoxesIcon,
  CircleAlertIcon,
  Gamepad2Icon,
  RefreshCwIcon,
  SearchIcon,
  ServerIcon,
  UsersIcon,
} from "lucide-react";
import {
  useCallback,
  useMemo,
  useState,
  type ComponentType,
} from "react";
import { DetailSheet } from "@/components/detail-sheet";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchCluster } from "@/lib/api";
import {
  buildClusterFlow,
  type ClusterSelection,
  type ClusterStateFilter,
} from "@/lib/cluster-flow";
import type { DashboardClusterSnapshot } from "@/lib/contracts";
import { formatRelativeTime } from "@/lib/format";

const ClusterFlow = dynamic(
  () => import("@/components/cluster-flow").then((module) => module.ClusterFlow),
  {
    ssr: false,
    loading: () => <FlowSkeleton />,
  },
);

const stateItems: { label: string; value: ClusterStateFilter }[] = [
  { label: "Tous les états", value: "all" },
  { label: "Pool chaude", value: "warm" },
  { label: "Réservées", value: "reserved" },
  { label: "Démarrage", value: "starting" },
  { label: "À surveiller", value: "attention" },
];

function FlowSkeleton() {
  return (
    <div className="flow-skeleton">
      <Skeleton className="h-24 w-full" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
      <Skeleton className="h-52 w-full" />
    </div>
  );
}

function SummaryMetric({
  icon: Icon,
  label,
  value,
  detail,
}: {
  readonly icon: ComponentType<{ "aria-hidden"?: boolean }>;
  readonly label: string;
  readonly value: number;
  readonly detail?: string;
}) {
  return (
    <div className="summary-metric">
      <Icon aria-hidden />
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
        {detail ? <small>{detail}</small> : null}
      </div>
    </div>
  );
}

function SummaryStrip({ snapshot }: { snapshot: DashboardClusterSnapshot }) {
  const summary = snapshot.summary;
  return (
    <section className="summary-strip" aria-label="Synthèse du cluster">
      <SummaryMetric
        icon={BoxesIcon}
        label="Groupes"
        value={summary.enabledGroups}
      />
      <Separator orientation="vertical" />
      <SummaryMetric
        icon={ServerIcon}
        label="Instances"
        value={summary.activeInstances}
        detail={`${summary.runningInstances} en exécution`}
      />
      <Separator orientation="vertical" />
      <SummaryMetric
        icon={BoxIcon}
        label="Pool chaude"
        value={summary.warmInstances}
        detail={`+${summary.pendingWarmInstances} en préparation`}
      />
      <Separator orientation="vertical" />
      <SummaryMetric
        icon={ActivityIcon}
        label="Réservées"
        value={summary.reservedInstances}
      />
      <Separator orientation="vertical" />
      <SummaryMetric
        icon={Gamepad2Icon}
        label="Sessions"
        value={summary.activeSessions}
      />
      <Separator orientation="vertical" />
      <SummaryMetric
        icon={UsersIcon}
        label="Joueurs"
        value={summary.playersOnline}
        detail={`${summary.queuedPlayers} en file`}
      />
    </section>
  );
}

function SnapshotStatus({
  generatedAt,
  fetching,
  error,
}: {
  readonly generatedAt: string;
  readonly fetching: boolean;
  readonly error: boolean;
}) {
  return (
    <div className="snapshot-status" aria-live="polite">
      <span
        className="snapshot-pulse"
        data-state={error ? "error" : fetching ? "fetching" : "live"}
      />
      <span>
        {error
          ? "Dernière donnée connue"
          : fetching
            ? "Synchronisation"
            : "Cluster en direct"}
      </span>
      <small>{formatRelativeTime(generatedAt)}</small>
    </div>
  );
}

function Toolbar({
  snapshot,
  groupId,
  stateFilter,
  search,
  onGroupChange,
  onStateChange,
  onSearchChange,
  onRefresh,
  refreshing,
}: {
  readonly snapshot: DashboardClusterSnapshot;
  readonly groupId: string;
  readonly stateFilter: ClusterStateFilter;
  readonly search: string;
  readonly onGroupChange: (value: string) => void;
  readonly onStateChange: (value: ClusterStateFilter) => void;
  readonly onSearchChange: (value: string) => void;
  readonly onRefresh: () => void;
  readonly refreshing: boolean;
}) {
  const groupItems = useMemo(
    () => [
      { label: "Tous les groupes", value: "all" },
      ...snapshot.groups.map((group) => ({
        label: group.id,
        value: group.id,
      })),
    ],
    [snapshot.groups],
  );
  return (
    <div className="cluster-toolbar">
      <div className="cluster-search">
        <SearchIcon aria-hidden="true" />
        <Input
          aria-label="Rechercher une instance, variante ou session"
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Instance, variante, session…"
        />
      </div>
      <Select
        items={groupItems}
        value={groupId}
        onValueChange={(value) => onGroupChange(value ?? "all")}
      >
        <SelectTrigger aria-label="Filtrer par groupe">
          <SelectValue />
        </SelectTrigger>
        <SelectContent alignItemWithTrigger={false}>
          <SelectGroup>
            {groupItems.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      <Select
        items={stateItems}
        value={stateFilter}
        onValueChange={(value) =>
          onStateChange((value as ClusterStateFilter | null) ?? "all")
        }
      >
        <SelectTrigger aria-label="Filtrer par état">
          <SelectValue />
        </SelectTrigger>
        <SelectContent alignItemWithTrigger={false}>
          <SelectGroup>
            {stateItems.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      <Button variant="outline" onClick={onRefresh} disabled={refreshing}>
        <RefreshCwIcon data-icon="inline-start" />
        Actualiser
      </Button>
    </div>
  );
}

export function DashboardShell() {
  const [groupId, setGroupId] = useState("all");
  const [stateFilter, setStateFilter] = useState<ClusterStateFilter>("all");
  const [search, setSearch] = useState("");
  const [selection, setSelection] = useState<ClusterSelection | null>(null);
  const clusterQuery = useQuery({
    queryKey: ["cluster"],
    queryFn: fetchCluster,
    refetchInterval: 5_000,
    refetchIntervalInBackground: false,
    placeholderData: (previous) => previous,
  });
  const snapshot = clusterQuery.data;
  const flowModel = useMemo(
    () =>
      snapshot
        ? buildClusterFlow(snapshot, {
            groupId,
            state: stateFilter,
            search,
          })
        : null,
    [groupId, search, snapshot, stateFilter],
  );
  const handleSelect = useCallback((nextSelection: ClusterSelection) => {
    setSelection(nextSelection);
  }, []);

  return (
    <main id="main-content" className="dashboard-shell">
      <header className="dashboard-header">
        <div className="endercloud-wordmark" aria-label="EnderCloud">
          <span>EC</span>
          <div>
            <strong>EnderCloud</strong>
            <small>cluster control</small>
          </div>
        </div>
        <div className="dashboard-heading">
          <p>Vue opérationnelle</p>
          <h1>Topologie du cluster</h1>
        </div>
        {snapshot ? (
          <SnapshotStatus
            generatedAt={snapshot.generatedAt}
            fetching={clusterQuery.isFetching}
            error={clusterQuery.isError}
          />
        ) : null}
      </header>

      {snapshot ? <SummaryStrip snapshot={snapshot} /> : null}

      {clusterQuery.isError ? (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>Synchronisation interrompue</AlertTitle>
          <AlertDescription>
            {snapshot
              ? "La dernière topologie reçue reste affichée pendant la reconnexion."
              : clusterQuery.error.message}
          </AlertDescription>
        </Alert>
      ) : null}

      {snapshot ? (
        <Toolbar
          snapshot={snapshot}
          groupId={groupId}
          stateFilter={stateFilter}
          search={search}
          onGroupChange={setGroupId}
          onStateChange={setStateFilter}
          onSearchChange={setSearch}
          onRefresh={() => void clusterQuery.refetch()}
          refreshing={clusterQuery.isFetching}
        />
      ) : null}

      <section className="cluster-stage" aria-label="Carte du cluster">
        {clusterQuery.isPending ? <FlowSkeleton /> : null}
        {flowModel && flowModel.nodes.length > 0 ? (
          <ClusterFlow model={flowModel} onSelect={handleSelect} />
        ) : null}
        {snapshot && flowModel?.nodes.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <SearchIcon />
              </EmptyMedia>
              <EmptyTitle>Aucun groupe ne correspond</EmptyTitle>
              <EmptyDescription>
                Modifiez la recherche ou les filtres pour retrouver la topologie.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : null}
        {!snapshot && clusterQuery.isError ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <CircleAlertIcon />
              </EmptyMedia>
              <EmptyTitle>Cluster inaccessible</EmptyTitle>
              <EmptyDescription>
                Le dashboard réessaie automatiquement toutes les cinq secondes.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : null}
        <div className="cluster-legend" aria-label="Légende">
          <span><i data-state="warm" /> Chaude</span>
          <span><i data-state="reserved" /> Réservée</span>
          <span><i data-state="transition" /> Transition</span>
          <span><i data-state="error" /> Incident</span>
        </div>
      </section>

      <DetailSheet selection={selection} onClose={() => setSelection(null)} />
    </main>
  );
}
