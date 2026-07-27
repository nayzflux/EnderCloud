"use client";

import { useQuery } from "@tanstack/react-query";
import {
  CircleAlertIcon,
  Gamepad2Icon,
  ServerIcon,
  UsersIcon,
} from "lucide-react";
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
import { fetchInstance, fetchQueue, fetchSession } from "@/lib/api";
import type {
  DashboardInstanceDetail,
  DashboardQueueDetail,
  DashboardSessionDetail,
} from "@/lib/contracts";
import type { ClusterSelection } from "@/lib/cluster-flow";
import {
  formatBytes,
  formatDateTime,
  formatRelativeTime,
} from "@/lib/format";

type SelectionDetail =
  | DashboardQueueDetail
  | DashboardInstanceDetail
  | DashboardSessionDetail;

interface DetailSheetProps {
  readonly selection: ClusterSelection | null;
  readonly onClose: () => void;
}

function DetailSkeleton() {
  return (
    <div className="flex flex-col gap-6 p-6">
      <Skeleton className="h-20 w-full" />
      <Skeleton className="h-44 w-full" />
      <Skeleton className="h-32 w-full" />
    </div>
  );
}

function DetailSection({
  title,
  children,
}: {
  readonly title: string;
  readonly children: React.ReactNode;
}) {
  return (
    <section className="detail-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function KeyValue({
  label,
  value,
  technical = false,
}: {
  readonly label: string;
  readonly value: React.ReactNode;
  readonly technical?: boolean;
}) {
  return (
    <div className="detail-key-value">
      <dt>{label}</dt>
      <dd data-technical={technical}>{value}</dd>
    </div>
  );
}

function QueueDetail({ detail }: { detail: DashboardQueueDetail }) {
  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="detail-hero">
        <div>
          <span>Parties</span>
          <strong>{detail.totalParties}</strong>
        </div>
        <div>
          <span>Joueurs</span>
          <strong>{detail.totalPlayers}</strong>
        </div>
      </div>
      <DetailSection title="Plus anciennes entrées">
        {detail.entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Aucun joueur n’attend dans cette file.
          </p>
        ) : (
          <ol className="detail-list">
            {detail.entries.map((entry) => (
              <li key={entry.id}>
                <div className="flex items-center justify-between gap-3">
                  <code>{entry.partyId}</code>
                  <Badge variant="outline">
                    {entry.players.length} joueur
                    {entry.players.length === 1 ? "" : "s"}
                  </Badge>
                </div>
                <p>{formatRelativeTime(entry.joinedAt)}</p>
                <div className="detail-technical-list">
                  {entry.players.map((player) => (
                    <code key={player}>{player}</code>
                  ))}
                </div>
              </li>
            ))}
          </ol>
        )}
        {detail.truncated ? (
          <p className="text-sm text-muted-foreground">
            Seules les 50 entrées les plus anciennes sont affichées.
          </p>
        ) : null}
      </DetailSection>
    </div>
  );
}

function InstanceDetail({ detail }: { detail: DashboardInstanceDetail }) {
  const { instance, variant } = detail;
  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex flex-wrap gap-2">
        <Badge>{instance.lifecycleState}</Badge>
        <Badge variant="secondary">{instance.availabilityState}</Badge>
        <Badge variant="outline">{instance.groupType}</Badge>
      </div>
      <DetailSection title="Exécution">
        <dl className="detail-grid">
          <KeyValue label="Groupe" value={instance.groupId} technical />
          <KeyValue label="Variante" value={instance.variantId} technical />
          <KeyValue label="Endpoint" value={instance.endpoint ?? "En attente"} technical />
          <KeyValue
            label="Joueurs"
            value={`${instance.playerCount}/${instance.maximumPlayers}`}
          />
          <KeyValue label="Conteneur" value={instance.containerId ?? "—"} technical />
          <KeyValue label="Runtime" value={instance.runtimePath ?? "—"} technical />
          <KeyValue label="Créée" value={formatDateTime(instance.createdAt)} />
          <KeyValue label="Démarrée" value={formatDateTime(instance.runningAt)} />
          <KeyValue label="Drain" value={formatDateTime(instance.drainDeadline)} />
          <KeyValue label="Mise à jour" value={formatDateTime(instance.updatedAt)} />
        </dl>
      </DetailSection>
      <Separator />
      <DetailSection title="Variante">
        <dl className="detail-grid">
          <KeyValue label="Image" value={variant.runtime.image} technical />
          <KeyValue label="Révision" value={variant.revision} />
          <KeyValue label="CPU" value={variant.runtime.cpu} />
          <KeyValue label="Mémoire" value={formatBytes(variant.runtime.memoryBytes)} />
          <KeyValue label="Checksum" value={variant.checksum} technical />
        </dl>
      </DetailSection>
      <Separator />
      <DetailSection title={`Joueurs connectés · ${detail.players.length}`}>
        {detail.players.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Aucun joueur actuellement observé.
          </p>
        ) : (
          <ul className="detail-list">
            {detail.players.map((player) => (
              <li key={player.playerId}>
                <code>{player.playerId}</code>
                <p>Dernier signal {formatRelativeTime(player.lastSeenAt)}</p>
              </li>
            ))}
          </ul>
        )}
      </DetailSection>
      <Separator />
      <DetailSection title="Commandes récentes">
        {detail.commands.length === 0 ? (
          <p className="text-sm text-muted-foreground">Aucune commande enregistrée.</p>
        ) : (
          <ul className="detail-list">
            {detail.commands.map((command) => (
              <li key={command.id}>
                <div className="flex items-center justify-between gap-3">
                  <strong>{command.operation}</strong>
                  <Badge
                    variant={command.state === "FAILED" ? "destructive" : "outline"}
                  >
                    {command.state}
                  </Badge>
                </div>
                <p>
                  {command.attempts} tentative(s) · {formatDateTime(command.createdAt)}
                </p>
                {command.lastError ? (
                  <p className="text-destructive">{command.lastError}</p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </DetailSection>
      <Separator />
      <DetailSection title="Événements récents">
        {detail.events.length === 0 ? (
          <p className="text-sm text-muted-foreground">Aucun événement enregistré.</p>
        ) : (
          <ul className="detail-list">
            {detail.events.map((event) => (
              <li key={event.id}>
                <strong>{event.type}</strong>
                <p>{formatDateTime(event.createdAt)}</p>
              </li>
            ))}
          </ul>
        )}
      </DetailSection>
    </div>
  );
}

function SessionDetail({ detail }: { detail: DashboardSessionDetail }) {
  const { session } = detail;
  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex flex-wrap gap-2">
        <Badge>{session.state}</Badge>
        <Badge variant="outline">
          révision {session.assignmentRevision}
        </Badge>
      </div>
      <DetailSection title="Cycle de vie">
        <dl className="detail-grid">
          <KeyValue label="Groupe" value={session.groupId} technical />
          <KeyValue label="Instance" value={session.instanceId ?? "Non affectée"} technical />
          <KeyValue
            label="Joueurs"
            value={`${session.connectedPlayerCount}/${session.activePlayerCount} connectés`}
          />
          <KeyValue label="Équipes actives" value={session.teamCount} />
          <KeyValue label="Créée" value={formatDateTime(session.createdAt)} />
          <KeyValue label="Démarrée" value={formatDateTime(session.startedAt)} />
          <KeyValue label="Deadline" value={formatDateTime(session.waitingDeadline)} />
          <KeyValue
            label="Affectation acquittée"
            value={formatDateTime(session.assignmentAcknowledgedAt)}
          />
        </dl>
      </DetailSection>
      <Separator />
      <DetailSection title={`Équipes · ${detail.teams.length}`}>
        {detail.teams.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Aucun joueur n’est encore affecté.
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            {detail.teams.map((team) => (
              <article className="detail-team" key={team.teamIndex}>
                <div className="flex items-center justify-between gap-3">
                  <strong>Équipe {team.teamIndex + 1}</strong>
                  <Badge variant="outline">{team.players.length}</Badge>
                </div>
                <ul>
                  {team.players.map((player) => (
                    <li key={player.playerId}>
                      <code>{player.playerId}</code>
                      <span>{player.state}</span>
                    </li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
        )}
      </DetailSection>
      <Separator />
      <DetailSection title="Transferts récents">
        {detail.transfers.length === 0 ? (
          <p className="text-sm text-muted-foreground">Aucun transfert enregistré.</p>
        ) : (
          <ul className="detail-list">
            {detail.transfers.map((transfer) => (
              <li key={transfer.id}>
                <div className="flex items-center justify-between gap-3">
                  <code>{transfer.id}</code>
                  <Badge variant="outline">{transfer.state}</Badge>
                </div>
                <p>
                  {transfer.attempts} tentative(s) · expire{" "}
                  {formatRelativeTime(transfer.expiresAt)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </DetailSection>
    </div>
  );
}

function DetailContent({
  selection,
  detail,
}: {
  readonly selection: ClusterSelection;
  readonly detail: SelectionDetail;
}) {
  if (selection.kind === "queue" && "entries" in detail) {
    return <QueueDetail detail={detail} />;
  }
  if (selection.kind === "instance" && "instance" in detail) {
    return <InstanceDetail detail={detail} />;
  }
  if (selection.kind === "session" && "teams" in detail) {
    return <SessionDetail detail={detail} />;
  }
  return null;
}

function selectionTitle(selection: ClusterSelection | null): {
  title: string;
  description: string;
  icon: React.ComponentType;
} {
  if (selection?.kind === "instance") {
    return {
      title: "Instance",
      description: selection.id,
      icon: ServerIcon,
    };
  }
  if (selection?.kind === "session") {
    return {
      title: "Session de jeu",
      description: selection.id,
      icon: Gamepad2Icon,
    };
  }
  return {
    title: "File de matchmaking",
    description: selection?.groupId ?? "",
    icon: UsersIcon,
  };
}

export function DetailSheet({ selection, onClose }: DetailSheetProps) {
  const detailQuery = useQuery({
    queryKey: ["detail", selection?.kind, selection?.id],
    queryFn: async (): Promise<SelectionDetail> => {
      if (!selection) throw new Error("Aucune sélection");
      if (selection.kind === "queue") return fetchQueue(selection.groupId);
      if (selection.kind === "instance") return fetchInstance(selection.id);
      return fetchSession(selection.id);
    },
    enabled: Boolean(selection),
    refetchInterval: selection ? 5_000 : false,
  });
  const heading = selectionTitle(selection);
  const HeadingIcon = heading.icon;

  return (
    <Sheet
      open={Boolean(selection)}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent side="right" className="w-full sm:max-w-xl">
        <SheetHeader>
          <div className="flex items-center gap-3">
            <span className="detail-heading-icon">
              <HeadingIcon aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <SheetTitle>{heading.title}</SheetTitle>
              <SheetDescription className="truncate">
                <code>{heading.description}</code>
              </SheetDescription>
            </div>
          </div>
        </SheetHeader>
        <ScrollArea className="min-h-0 flex-1">
          {detailQuery.isPending ? <DetailSkeleton /> : null}
          {detailQuery.isError ? (
            <div className="p-6">
              <Alert variant="destructive">
                <CircleAlertIcon />
                <AlertTitle>Détail indisponible</AlertTitle>
                <AlertDescription>{detailQuery.error.message}</AlertDescription>
              </Alert>
            </div>
          ) : null}
          {selection && detailQuery.data ? (
            <DetailContent selection={selection} detail={detailQuery.data} />
          ) : null}
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
