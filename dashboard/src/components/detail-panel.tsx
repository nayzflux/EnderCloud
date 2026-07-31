"use client";

import { useQuery } from "@tanstack/react-query";
import {
  BoxIcon,
  CircleAlertIcon,
  ExternalLinkIcon,
  Gamepad2Icon,
} from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { CopyableId } from "@/components/copyable-id";
import { Countdown, Elapsed, RelativeTime } from "@/components/live-time";
import { KeyValue, KeyValueGrid, SectionTitle } from "@/components/page-header";
import { Timeline, type TimelineStep } from "@/components/timeline";
import {
  AvailabilityBadge,
  LifecycleBadge,
  SessionPlayerBadge,
  SessionStateBadge,
  WorkStateBadge,
} from "@/components/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { fetchInstance, fetchSession } from "@/lib/api";
import type {
  ActiveDeadlineKind,
  DashboardInstance,
  DashboardInstanceDetail,
  DashboardSession,
  DashboardSessionDetail,
} from "@/lib/contracts";
import { formatBytes, formatDateTime, ratio } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Ordered lifecycle of a managed container, as the orchestrator records it. */
function instanceSteps(
  instance: DashboardInstanceDetail["instance"],
): readonly TimelineStep[] {
  const failed =
    instance.lifecycleState === "FAILED" ||
    instance.lifecycleState === "ORPHANED";

  const steps: TimelineStep[] = [
    { id: "created", label: "Created", at: instance.createdAt },
    { id: "starting", label: "Container starting", at: instance.startingAt },
    {
      id: "running",
      label: "Ready",
      at: instance.runningAt,
      hint: instance.runningAt ? undefined : "waiting for the readiness signal",
    },
    { id: "draining", label: "Draining", at: instance.drainingAt, tone: "warning" },
    { id: "stopping", label: "Stopping", at: instance.stoppingAt, tone: "warning" },
    { id: "stopped", label: "Stopped", at: instance.stoppedAt, tone: "neutral" },
  ];

  if (failed) {
    steps.push({
      id: "failed",
      label:
        instance.lifecycleState === "ORPHANED" ? "Orphaned" : "Failed",
      at: instance.updatedAt,
      tone: "danger",
    });
  }
  return steps;
}

const deadlineLabels: Readonly<Record<ActiveDeadlineKind, string>> = {
  INSTANCE_STARTUP: "Startup deadline",
  INSTANCE_RENEWAL: "Instance renewal deadline",
  INSTANCE_DRAIN: "Drain deadline",
  CANCELLED_INSTANCE_DRAIN: "Cancelled-session drain deadline",
  INSTANCE_SHUTDOWN: "Shutdown deadline",
  INSTANCE_ACQUISITION: "Instance acquisition deadline",
  PLAYER_TRANSFER: "Player transfer deadline",
  LOBBY_STALE: "Lobby stale deadline",
};

/** Ordered lifecycle of a match, from formation to teardown. */
function sessionSteps(
  session: DashboardSession & { readonly groupId: string },
): readonly TimelineStep[] {
  const steps: TimelineStep[] = [
    { id: "created", label: "Formed from the queue", at: session.createdAt },
    {
      id: "assigned",
      label: "Instance acknowledged",
      at: session.assignmentAcknowledgedAt,
      hint: session.instanceId ? undefined : "no instance assigned yet",
    },
    { id: "started", label: "Game started", at: session.startedAt },
    { id: "finished", label: "Finished", at: session.finishedAt, tone: "neutral" },
  ];

  if (session.state === "FAILED" || session.state === "CANCELLED") {
    steps.push({
      id: "terminal",
      label: session.state === "FAILED" ? "Failed" : "Cancelled",
      at: session.updatedAt,
      tone: session.state === "FAILED" ? "danger" : "neutral",
    });
  }
  return steps;
}

function instanceSettled(instance: DashboardInstance): boolean {
  return (
    instance.lifecycleState === "STOPPED" ||
    instance.lifecycleState === "FAILED" ||
    instance.lifecycleState === "ORPHANED"
  );
}

function sessionSettled(session: DashboardSession): boolean {
  return (
    session.state === "FINISHED" ||
    session.state === "CANCELLED" ||
    session.state === "FAILED"
  );
}

type Selection =
  | { readonly kind: "instance"; readonly id: string }
  | { readonly kind: "session"; readonly id: string }
  | null;

interface DetailPanelContextValue {
  readonly openInstance: (instanceId: string) => void;
  readonly openSession: (sessionId: string) => void;
  readonly close: () => void;
}

const DetailPanelContext = createContext<DetailPanelContextValue | null>(null);

export function DetailPanelProvider({
  children,
}: {
  readonly children: ReactNode;
}) {
  const [selection, setSelection] = useState<Selection>(null);

  const value = useMemo<DetailPanelContextValue>(
    () => ({
      openInstance: (id) => setSelection({ kind: "instance", id }),
      openSession: (id) => setSelection({ kind: "session", id }),
      close: () => setSelection(null),
    }),
    [],
  );

  const handleOpenChange = useCallback((open: boolean) => {
    if (!open) setSelection(null);
  }, []);

  return (
    <DetailPanelContext.Provider value={value}>
      {children}
      <Sheet open={selection !== null} onOpenChange={handleOpenChange}>
        <SheetContent
          side="right"
          className="gap-0 p-0 data-[side=right]:w-full sm:max-w-2xl!"
          aria-label="Details"
        >
          {selection?.kind === "instance" ? (
            <InstancePanel instanceId={selection.id} />
          ) : null}
          {selection?.kind === "session" ? (
            <SessionPanel sessionId={selection.id} />
          ) : null}
        </SheetContent>
      </Sheet>
    </DetailPanelContext.Provider>
  );
}

export function useDetailPanel(): DetailPanelContextValue {
  const context = useContext(DetailPanelContext);
  if (!context) {
    throw new Error("useDetailPanel must be used within a DetailPanelProvider.");
  }
  return context;
}

function PanelSkeleton() {
  return (
    <div className="flex flex-col gap-4 p-4">
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-28 w-full" />
    </div>
  );
}

function PanelError({ message }: { readonly message: string }) {
  return (
    <div className="p-4">
      <Alert variant="destructive">
        <CircleAlertIcon />
        <AlertTitle>Details unavailable</AlertTitle>
        <AlertDescription>{message}</AlertDescription>
      </Alert>
    </div>
  );
}

function PanelHeader({
  icon,
  title,
  id,
  children,
}: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly id: string;
  readonly children?: ReactNode;
}) {
  return (
    <SheetHeader className="gap-3 border-b p-4">
      <div className="flex items-start gap-3 pr-8">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground [&_svg]:size-4">
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription render={<div />}>
            <CopyableId value={id} className="text-muted-foreground" />
          </SheetDescription>
        </div>
      </div>
      {children ? <div className="flex flex-wrap gap-1.5">{children}</div> : null}
    </SheetHeader>
  );
}

function EmptyLine({ children }: { readonly children: ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}

function ListCard({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <li
      className={cn(
        "space-y-1.5 rounded-lg border px-3 py-2.5 text-sm",
        className,
      )}
    >
      {children}
    </li>
  );
}

function InstancePanel({ instanceId }: { readonly instanceId: string }) {
  const query = useQuery({
    queryKey: ["instance", instanceId],
    queryFn: () => fetchInstance(instanceId),
    refetchInterval: 5_000,
  });

  if (query.isPending) return <PanelSkeleton />;
  if (query.isError) return <PanelError message={query.error.message} />;

  const detail: DashboardInstanceDetail = query.data;
  const { instance, variant } = detail;

  return (
    <>
      <PanelHeader
        icon={<BoxIcon />}
        title="Instance"
        id={instance.id}
      >
        <LifecycleBadge state={instance.lifecycleState} />
        <AvailabilityBadge state={instance.availabilityState} />
        <Badge variant="outline" className="font-mono text-[0.65rem]">
          {instance.groupId}
        </Badge>
      </PanelHeader>

      <Tabs defaultValue="overview" className="min-h-0 flex-1 gap-0">
        <TabsList
          variant="line"
          className="mx-4 mt-3 w-[calc(100%-2rem)] shrink-0 justify-start overflow-x-auto"
        >
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="players">
            Players
            <span className="text-muted-foreground tabular">
              {detail.players.length}
            </span>
          </TabsTrigger>
          <TabsTrigger value="commands">
            Commands
            <span className="text-muted-foreground tabular">
              {detail.commands.length}
            </span>
          </TabsTrigger>
          <TabsTrigger value="events">
            Events
            <span className="text-muted-foreground tabular">
              {detail.events.length}
            </span>
          </TabsTrigger>
        </TabsList>
        <Separator className="mt-3" />

        <ScrollArea className="min-h-0 flex-1">
          <TabsContent value="overview" className="space-y-5 p-4">
            <div className="rounded-lg border p-3">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-xs text-muted-foreground">
                  Player occupancy
                </span>
                <span className="font-mono text-sm tabular">
                  {instance.playerCount}/{instance.maximumPlayers}
                </span>
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-foreground/70"
                  style={{
                    width: `${ratio(instance.playerCount, instance.maximumPlayers)}%`,
                  }}
                />
              </div>
            </div>

            <section className="space-y-3">
              <SectionTitle>Runtime</SectionTitle>
              <KeyValueGrid>
                <KeyValue label="Group">{instance.groupId}</KeyValue>
                <KeyValue label="Group type">{instance.groupType}</KeyValue>
                <KeyValue label="Variant" mono>
                  {instance.variantId}
                </KeyValue>
                <KeyValue label="Endpoint" mono>
                  {instance.endpoint ?? "Awaiting registration"}
                </KeyValue>
                <KeyValue label="Container" mono>
                  {instance.containerId ?? "—"}
                </KeyValue>
                <KeyValue label="Runtime path" mono>
                  {instance.runtimePath ?? "—"}
                </KeyValue>
                <KeyValue label="Session" mono>
                  {instance.sessionId ?? "None"}
                </KeyValue>
                {instance.replacesInstanceId ? (
                  <KeyValue label="Replaces" mono>
                    {instance.replacesInstanceId}
                  </KeyValue>
                ) : null}
                <KeyValue label="Age">
                  <Elapsed value={instance.createdAt} />
                </KeyValue>
              </KeyValueGrid>
            </section>

            <section className="space-y-3">
              <SectionTitle>Lifecycle</SectionTitle>
              <Timeline
                steps={instanceSteps(instance)}
                settled={instanceSettled(instance)}
                deadline={
                  detail.activeDeadline
                    ? {
                        label: deadlineLabels[detail.activeDeadline.kind],
                        at: detail.activeDeadline.at,
                      }
                    : undefined
                }
              />
              <p className="text-xs text-muted-foreground">
                Last update <RelativeTime value={instance.updatedAt} />
              </p>
            </section>

            <section className="space-y-3">
              <SectionTitle>Variant</SectionTitle>
              <KeyValueGrid>
                <KeyValue label="Image" mono>
                  {variant.runtime.image}
                </KeyValue>
                <KeyValue label="Revision">{variant.revision}</KeyValue>
                <KeyValue label="CPU">{variant.runtime.cpu} vCPU</KeyValue>
                <KeyValue label="Memory">
                  {formatBytes(variant.runtime.memoryBytes)}
                </KeyValue>
                <KeyValue label="Weight">{variant.weight}</KeyValue>
                <KeyValue label="Enabled">
                  {variant.enabled ? "Yes" : "No"}
                </KeyValue>
                <KeyValue label="Checksum" mono wide>
                  {variant.checksum}
                </KeyValue>
              </KeyValueGrid>
              {Object.keys(variant.runtime.environment).length > 0 ? (
                <div className="rounded-lg border">
                  <p className="border-b px-3 py-1.5 text-xs text-muted-foreground">
                    Environment
                  </p>
                  <dl className="divide-y">
                    {Object.entries(variant.runtime.environment).map(
                      ([key, envValue]) => (
                        <div
                          key={key}
                          className="flex items-baseline justify-between gap-4 px-3 py-1.5"
                        >
                          <dt className="font-mono text-xs text-muted-foreground">
                            {key}
                          </dt>
                          <dd className="truncate font-mono text-xs">
                            {envValue}
                          </dd>
                        </div>
                      ),
                    )}
                  </dl>
                </div>
              ) : null}
            </section>
          </TabsContent>

          <TabsContent value="players" className="space-y-3 p-4">
            {detail.players.length === 0 ? (
              <EmptyLine>No player is currently connected.</EmptyLine>
            ) : (
              <ul className="space-y-2">
                {detail.players.map((player) => (
                  <ListCard key={player.playerId}>
                    <CopyableId value={player.playerId} label="player id" />
                    <p className="text-xs text-muted-foreground">
                      Connected <RelativeTime value={player.connectedAt} /> ·
                      last seen <RelativeTime value={player.lastSeenAt} />
                    </p>
                  </ListCard>
                ))}
              </ul>
            )}
          </TabsContent>

          <TabsContent value="commands" className="space-y-3 p-4">
            {detail.commands.length === 0 ? (
              <EmptyLine>No command has been recorded.</EmptyLine>
            ) : (
              <ul className="space-y-2">
                {detail.commands.map((command) => (
                  <ListCard key={command.id}>
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-mono text-xs">
                        {command.operation}
                      </span>
                      <WorkStateBadge state={command.state} />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {command.attempts} attempt
                      {command.attempts === 1 ? "" : "s"} ·{" "}
                      <RelativeTime value={command.createdAt} />
                    </p>
                    {command.lastError ? (
                      <p className="rounded-md bg-destructive/10 px-2 py-1 font-mono text-xs text-destructive">
                        {command.lastError}
                      </p>
                    ) : null}
                  </ListCard>
                ))}
              </ul>
            )}
          </TabsContent>

          <TabsContent value="events" className="space-y-3 p-4">
            {detail.events.length === 0 ? (
              <EmptyLine>No event has been recorded.</EmptyLine>
            ) : (
              <ol className="space-y-2">
                {detail.events.map((event) => (
                  <ListCard key={event.id}>
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-mono text-xs">{event.type}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        <RelativeTime value={event.createdAt} />
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {formatDateTime(event.createdAt)}
                    </p>
                  </ListCard>
                ))}
              </ol>
            )}
          </TabsContent>
        </ScrollArea>
      </Tabs>
    </>
  );
}

function SessionPanel({ sessionId }: { readonly sessionId: string }) {
  const { openInstance } = useDetailPanel();
  const query = useQuery({
    queryKey: ["session", sessionId],
    queryFn: () => fetchSession(sessionId),
    refetchInterval: 5_000,
  });

  if (query.isPending) return <PanelSkeleton />;
  if (query.isError) return <PanelError message={query.error.message} />;

  const detail: DashboardSessionDetail = query.data;
  const { session } = detail;

  return (
    <>
      <PanelHeader icon={<Gamepad2Icon />} title="Session" id={session.id}>
        <SessionStateBadge state={session.state} />
        <Badge variant="outline" className="font-mono text-[0.65rem]">
          {session.groupId}
        </Badge>
        <Badge variant="outline">revision {session.assignmentRevision}</Badge>
      </PanelHeader>

      <Tabs defaultValue="overview" className="min-h-0 flex-1 gap-0">
        <TabsList
          variant="line"
          className="mx-4 mt-3 w-[calc(100%-2rem)] shrink-0 justify-start overflow-x-auto"
        >
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="tickets">
            Tickets
            <span className="text-muted-foreground tabular">
              {detail.tickets.length}
            </span>
          </TabsTrigger>
          <TabsTrigger value="transfers">
            Transfers
            <span className="text-muted-foreground tabular">
              {detail.transfers.length}
            </span>
          </TabsTrigger>
        </TabsList>
        <Separator className="mt-3" />

        <ScrollArea className="min-h-0 flex-1">
          <TabsContent value="overview" className="space-y-5 p-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-lg border p-3">
                <p className="text-xs text-muted-foreground">In session</p>
                <p className="font-heading text-xl font-semibold tabular">
                  {session.activePlayerCount}
                  <span className="text-sm font-normal text-muted-foreground">
                    /{session.maximumPlayerCount}
                  </span>
                </p>
                <p className="mt-1 text-[0.7rem] text-muted-foreground">
                  Active players / session capacity
                </p>
              </div>
              <div className="rounded-lg border p-3">
                <p className="text-xs text-muted-foreground">Transferred</p>
                <p className="font-heading text-xl font-semibold tabular">
                  {session.connectedPlayerCount}
                  <span className="text-sm font-normal text-muted-foreground">
                    /{session.activePlayerCount}
                  </span>
                </p>
                <p className="mt-1 text-[0.7rem] text-muted-foreground">
                  Connected to server / active players
                </p>
              </div>
              <div className="rounded-lg border p-3">
                <p className="text-xs text-muted-foreground">Tickets</p>
                <p className="font-heading text-xl font-semibold tabular">
                  {detail.tickets.length}
                </p>
              </div>
            </div>

            <section className="space-y-3">
              <SectionTitle>Assignment</SectionTitle>
              <KeyValueGrid>
                <KeyValue label="Group">{session.groupId}</KeyValue>
                <KeyValue label="Instance" mono>
                  {session.instanceId ? (
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 underline underline-offset-4 hover:text-primary"
                      onClick={() => openInstance(session.instanceId as string)}
                    >
                      {session.instanceId}
                      <ExternalLinkIcon className="size-3" />
                    </button>
                  ) : (
                    "Not assigned yet"
                  )}
                </KeyValue>
                <KeyValue label="Revision">{session.assignmentRevision}</KeyValue>
                <KeyValue label="Retries">{session.retryCount}</KeyValue>
                <KeyValue label="Acknowledged">
                  <RelativeTime value={session.assignmentAcknowledgedAt} />
                </KeyValue>
                <KeyValue label="Instance acquisition">
                  {session.instanceAcquisitionDeadline ? (
                    <Countdown value={session.instanceAcquisitionDeadline} />
                  ) : (
                    "Not waiting for capacity"
                  )}
                </KeyValue>
                <KeyValue label="Lobby stale">
                  {session.lobbyStaleDeadline ? (
                    <Countdown value={session.lobbyStaleDeadline} />
                  ) : (
                    "Not assigned yet"
                  )}
                </KeyValue>
              </KeyValueGrid>
            </section>

            <section className="flex flex-col gap-3">
              <SectionTitle>Feasible profiles</SectionTitle>
              <KeyValueGrid>
                <KeyValue label="Expected recommendation">
                  {detail.recommendedExpectedProfile?.join(" · ") ?? "None"}
                </KeyValue>
                <KeyValue label="Connected recommendation">
                  {detail.recommendedConnectedProfile?.join(" · ") ?? "None"}
                </KeyValue>
                <KeyValue label="Expected possibilities">
                  {detail.expectedProfiles.length}
                </KeyValue>
                <KeyValue label="Connected possibilities">
                  {detail.connectedProfiles.length}
                </KeyValue>
              </KeyValueGrid>
            </section>

            <section className="space-y-3">
              <SectionTitle>Lifecycle</SectionTitle>
              <Timeline
                steps={sessionSteps(session)}
                settled={sessionSettled(session)}
                deadline={
                  detail.activeDeadline
                    ? {
                        label: deadlineLabels[detail.activeDeadline.kind],
                        at: detail.activeDeadline.at,
                      }
                    : undefined
                }
              />
              <p className="text-xs text-muted-foreground">
                Last update <RelativeTime value={session.updatedAt} />
              </p>
            </section>
          </TabsContent>

          <TabsContent value="tickets" className="flex flex-col gap-3 p-4">
            {detail.tickets.length === 0 ? (
              <EmptyLine>No ticket has been assigned yet.</EmptyLine>
            ) : (
              <div className="flex flex-col gap-3">
                {detail.tickets.map((ticket) => (
                  <article
                    key={ticket.ticketId}
                    className="overflow-hidden rounded-lg border"
                  >
                    <header className="flex items-center justify-between gap-3 border-b bg-muted/40 px-3 py-2">
                      <CopyableId value={ticket.partyId} label="party id" />
                      <Badge variant="outline">
                        {ticket.players.length} player
                        {ticket.players.length === 1 ? "" : "s"}
                      </Badge>
                    </header>
                    <ul className="divide-y">
                      {ticket.players.map((player) => (
                        <li
                          key={player.playerId}
                          className="flex items-center justify-between gap-3 px-3 py-2"
                        >
                          <CopyableId
                            value={player.playerId}
                            label="player id"
                            className="min-w-0"
                          />
                          <SessionPlayerBadge state={player.state} />
                        </li>
                      ))}
                    </ul>
                  </article>
                ))}
              </div>
            )}
          </TabsContent>

          <TabsContent value="transfers" className="space-y-3 p-4">
            {detail.transfers.length === 0 ? (
              <EmptyLine>No transfer has been recorded.</EmptyLine>
            ) : (
              <ul className="space-y-2">
                {detail.transfers.map((transfer) => (
                  <ListCard key={transfer.id}>
                    <div className="flex items-center justify-between gap-3">
                      <CopyableId value={transfer.id} label="transfer id" />
                      <WorkStateBadge state={transfer.state} />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {transfer.attempts} attempt
                      {transfer.attempts === 1 ? "" : "s"} · expires{" "}
                      <RelativeTime value={transfer.expiresAt} />
                    </p>
                  </ListCard>
                ))}
              </ul>
            )}
          </TabsContent>
        </ScrollArea>
      </Tabs>
    </>
  );
}
