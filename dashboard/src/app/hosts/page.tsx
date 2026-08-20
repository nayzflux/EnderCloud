"use client";

import {
  AlertTriangleIcon,
  PowerIcon,
  ServerCogIcon,
  WrenchIcon,
} from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { ClusterGate } from "@/components/cluster-gate";
import { useCluster } from "@/components/cluster-provider";
import { CopyableId } from "@/components/copyable-id";
import { DataTable, type Column } from "@/components/data-table";
import { RelativeTime } from "@/components/live-time";
import { KeyValue, KeyValueGrid, PageHeader, SectionTitle } from "@/components/page-header";
import {
  HostAdminBadge,
  HostHealthBadge,
  LifecycleBadge,
} from "@/components/status-badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { activateHost, drainHost } from "@/lib/api";
import type {
  DashboardGroup,
  DashboardHost,
  DashboardInstance,
} from "@/lib/contracts";
import { formatBytes, formatPercent, ratio } from "@/lib/format";

interface HostInstance {
  readonly group: DashboardGroup;
  readonly instance: DashboardInstance;
}

function ResourceCell({
  label,
  reserved,
  total,
  format,
}: {
  readonly label: string;
  readonly reserved: number;
  readonly total: number;
  readonly format: (value: number) => string;
}) {
  return (
    <div className="w-36 space-y-1">
      <div className="flex items-baseline justify-between gap-2 font-mono text-xs tabular">
        <span>{formatPercent(reserved, total)}</span>
        <span className="text-muted-foreground">
          {format(reserved)} / {format(total)}
        </span>
      </div>
      <Progress value={ratio(reserved, total)} aria-label={`${label} reservation`} />
    </div>
  );
}

function HostAction({
  host,
  action,
}: {
  readonly host: DashboardHost;
  readonly action: "drain" | "activate";
}) {
  const { refresh } = useCluster();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const draining = action === "drain";

  async function confirm() {
    setPending(true);
    try {
      const result = draining
        ? await drainHost(host.id)
        : await activateHost(host.id);
      if (!result.accepted) {
        throw new Error("The orchestrator rejected the state transition.");
      }
      setOpen(false);
      refresh();
      toast.success(draining ? "Host drain started." : "Host reactivated.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Host action failed.");
    } finally {
      setPending(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger
        render={
          <Button variant={draining ? "destructive" : "default"} size="sm" />
        }
      >
        {draining ? <WrenchIcon /> : <PowerIcon />}
        {draining ? "Drain host" : "Reactivate host"}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogMedia>
            {draining ? <AlertTriangleIcon /> : <PowerIcon />}
          </AlertDialogMedia>
          <AlertDialogTitle>
            {draining ? `Drain ${host.id}?` : `Reactivate ${host.id}?`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {draining
              ? "New work will stop immediately. Empty sessions and open capacity will move to other hosts while occupied games finish in place."
              : "The host will enter recovery and accept work only after its inventory has been reconciled."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant={draining ? "destructive" : "default"}
            disabled={pending}
            onClick={() => void confirm()}
          >
            {pending ? "Applying…" : draining ? "Start drain" : "Reactivate"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function HostPanel({
  host,
  instances,
  onOpenChange,
}: {
  readonly host: DashboardHost | null;
  readonly instances: readonly HostInstance[];
  readonly onOpenChange: (open: boolean) => void;
}) {
  return (
    <Sheet open={host !== null} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="gap-0 p-0 data-[side=right]:w-full sm:max-w-2xl!"
      >
        {host ? (
          <>
            <SheetHeader className="gap-3 border-b p-4">
              <div className="flex items-start gap-3 pr-8">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted [&_svg]:size-4">
                  <ServerCogIcon />
                </span>
                <div className="min-w-0 flex-1">
                  <SheetTitle>{host.id}</SheetTitle>
                  <SheetDescription>
                    Agent {host.agentVersion} · {host.gameAddress}
                  </SheetDescription>
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5">
                <HostHealthBadge state={host.healthState} />
                <HostAdminBadge state={host.adminState} />
              </div>
            </SheetHeader>

            <ScrollArea className="min-h-0 flex-1">
              <div className="space-y-5 p-4">
                {host.lastError ? (
                  <Alert variant="destructive">
                    <AlertTriangleIcon />
                    <AlertTitle>Last control error</AlertTitle>
                    <AlertDescription className="font-mono text-xs">
                      {host.lastError}
                    </AlertDescription>
                  </Alert>
                ) : null}

                <section className="space-y-3">
                  <SectionTitle>Capacity</SectionTitle>
                  <div className="space-y-4 rounded-lg border p-3">
                    <ResourceCell
                      label="CPU"
                      reserved={host.reservedCpu}
                      total={host.allocatableCpu}
                      format={(value) => `${value.toFixed(2)} vCPU`}
                    />
                    <ResourceCell
                      label="Memory"
                      reserved={host.reservedMemoryBytes}
                      total={host.allocatableMemoryBytes}
                      format={formatBytes}
                    />
                  </div>
                </section>

                <section className="space-y-3">
                  <SectionTitle>Control</SectionTitle>
                  <KeyValueGrid>
                    <KeyValue label="Control URL" mono wide>
                      {host.controlUrl}
                    </KeyValue>
                    <KeyValue label="Game address" mono>
                      {host.gameAddress}
                    </KeyValue>
                    <KeyValue label="Agent version" mono>
                      {host.agentVersion}
                    </KeyValue>
                    <KeyValue label="Last heartbeat">
                      <RelativeTime value={host.lastHeartbeatAt} />
                    </KeyValue>
                    <KeyValue label="Last control call">
                      <RelativeTime
                        value={host.lastControlContactAt}
                        fallback="No successful call yet"
                      />
                    </KeyValue>
                  </KeyValueGrid>
                </section>

                <section className="space-y-3">
                  <SectionTitle count={instances.length}>Instances</SectionTitle>
                  {instances.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      No physical reservation remains on this host.
                    </p>
                  ) : (
                    <ul className="divide-y rounded-lg border">
                      {instances.map(({ group, instance }) => (
                        <li
                          key={instance.id}
                          className="flex items-center justify-between gap-4 px-3 py-2.5"
                        >
                          <div className="min-w-0 space-y-1">
                            <CopyableId value={instance.id} label="instance id" />
                            <p className="truncate font-mono text-xs text-muted-foreground">
                              {group.id} / {instance.variantId}
                            </p>
                          </div>
                          <LifecycleBadge state={instance.lifecycleState} />
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              </div>
            </ScrollArea>

            <Separator />
            <SheetFooter className="border-t-0">
              {host.adminState === "ACTIVE" ? (
                <HostAction host={host} action="drain" />
              ) : null}
              {host.adminState === "DRAINING" ? (
                <p className="text-xs text-muted-foreground">
                  Reactivation becomes available after every instance has stopped.
                </p>
              ) : null}
              {host.adminState === "MAINTENANCE" ? (
                <HostAction host={host} action="activate" />
              ) : null}
            </SheetFooter>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

export default function HostsPage() {
  const [selectedHostId, setSelectedHostId] = useState<string | null>(null);

  const columns = useMemo<readonly Column<DashboardHost>[]>(
    () => [
      {
        id: "id",
        header: "Host",
        cell: (host) => <CopyableId value={host.id} label="host id" />,
        sortValue: (host) => host.id,
      },
      {
        id: "health",
        header: "Health",
        cell: (host) => <HostHealthBadge state={host.healthState} />,
        sortValue: (host) => host.healthState,
      },
      {
        id: "admin",
        header: "Administrative",
        cell: (host) => <HostAdminBadge state={host.adminState} />,
        sortValue: (host) => host.adminState,
      },
      {
        id: "cpu",
        header: "CPU reserved",
        cell: (host) => (
          <ResourceCell
            label="CPU"
            reserved={host.reservedCpu}
            total={host.allocatableCpu}
            format={(value) => `${value.toFixed(1)}`}
          />
        ),
        sortValue: (host) => ratio(host.reservedCpu, host.allocatableCpu),
      },
      {
        id: "memory",
        header: "Memory reserved",
        hideOnMobile: true,
        cell: (host) => (
          <ResourceCell
            label="Memory"
            reserved={host.reservedMemoryBytes}
            total={host.allocatableMemoryBytes}
            format={formatBytes}
          />
        ),
        sortValue: (host) =>
          ratio(host.reservedMemoryBytes, host.allocatableMemoryBytes),
      },
      {
        id: "instances",
        header: "Instances",
        align: "right",
        cell: (host) => (
          <span className="font-mono text-xs tabular">{host.activeInstanceCount}</span>
        ),
        sortValue: (host) => host.activeInstanceCount,
      },
      {
        id: "contacts",
        header: "Last contacts",
        hideOnMobile: true,
        cell: (host) => (
          <div className="space-y-0.5 text-xs text-muted-foreground">
            <p>
              Heartbeat <RelativeTime value={host.lastHeartbeatAt} />
            </p>
            <p>
              Control <RelativeTime value={host.lastControlContactAt} />
            </p>
          </div>
        ),
        sortValue: (host) => Date.parse(host.lastHeartbeatAt),
      },
    ],
    [],
  );

  return (
    <>
      <PageHeader
        title="Hosts"
        description="Execution agents, their physical reservations and maintenance state."
      />
      <ClusterGate>
        {(snapshot) => {
          const selectedHost =
            snapshot.hosts.find((host) => host.id === selectedHostId) ?? null;
          const instances = snapshot.groups.flatMap((group) =>
            group.instances
              .filter((instance) => instance.hostId === selectedHostId)
              .map((instance) => ({ group, instance })),
          );

          return (
            <>
              <Card className="py-0">
                <CardContent className="px-0 py-2">
                  <DataTable
                    rows={snapshot.hosts}
                    columns={columns}
                    getRowId={(host) => host.id}
                    onRowClick={(host) => setSelectedHostId(host.id)}
                    initialSort={{ columnId: "id" }}
                    caption="Execution hosts"
                    emptyState={
                      <Empty className="py-12">
                        <EmptyHeader>
                          <EmptyMedia variant="icon">
                            <ServerCogIcon />
                          </EmptyMedia>
                          <EmptyTitle>No execution host</EmptyTitle>
                          <EmptyDescription>
                            Start an agent on the private network. Its first heartbeat
                            will register it here.
                          </EmptyDescription>
                        </EmptyHeader>
                      </Empty>
                    }
                  />
                </CardContent>
              </Card>
              <HostPanel
                host={selectedHost}
                instances={instances}
                onOpenChange={(open) => {
                  if (!open) setSelectedHostId(null);
                }}
              />
            </>
          );
        }}
      </ClusterGate>
    </>
  );
}
