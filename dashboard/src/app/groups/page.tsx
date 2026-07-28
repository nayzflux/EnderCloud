"use client";

import {
  BoxesIcon,
  Gamepad2Icon,
  Layers3Icon,
  ListOrderedIcon,
  ServerIcon,
  UsersIcon,
} from "lucide-react";
import Link from "next/link";
import { useState, type ComponentType } from "react";
import { ClusterGate } from "@/components/cluster-gate";
import { FilterBar, ResultCount, SearchField } from "@/components/filter-bar";
import { KeyValue, KeyValueGrid, PageHeader, SectionTitle } from "@/components/page-header";
import { GroupTypeBadge, StatusBadge } from "@/components/status-badge";
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
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { DashboardGroup } from "@/lib/contracts";
import { formatAge, formatBytes, formatDuration, ratio } from "@/lib/format";
import { needsAttention } from "@/lib/status";

function MiniStat({
  icon: Icon,
  label,
  value,
  hint,
}: {
  readonly icon: ComponentType<{ className?: string }>;
  readonly label: string;
  readonly value: string | number;
  readonly hint?: string;
}) {
  return (
    <div className="flex min-w-0 items-start gap-2.5">
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="font-heading text-base leading-tight font-semibold tabular">
          {value}
        </p>
        {hint ? (
          <p className="truncate text-xs text-muted-foreground">{hint}</p>
        ) : null}
      </div>
    </div>
  );
}

function GroupCard({ group }: { readonly group: DashboardGroup }) {
  const { capacity } = group;
  const players = group.instances.reduce(
    (total, instance) => total + instance.playerCount,
    0,
  );
  const seats = group.instances.reduce(
    (total, instance) => total + instance.maximumPlayers,
    0,
  );
  const attention = group.instances.filter(needsAttention).length;
  const activeSessions = group.sessions.filter(
    (session) =>
      session.state !== "FINISHED" &&
      session.state !== "CANCELLED" &&
      session.state !== "FAILED",
  ).length;

  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle className="flex flex-wrap items-center gap-2">
          <span className="font-mono">{group.id}</span>
          <GroupTypeBadge type={group.type} />
          {group.enabled ? (
            <StatusBadge tone="success" label="Enabled" />
          ) : (
            <StatusBadge tone="neutral" label="Disabled" />
          )}
          {attention > 0 ? (
            <StatusBadge tone="danger" label={`${attention} degraded`} />
          ) : null}
        </CardTitle>
        <CardDescription>
          {group.type === "hub"
            ? "Fallback lobby: players are routed to the least loaded instance."
            : "Matchmaking group: parties queue up and are placed on a reserved instance."}
        </CardDescription>
        <CardAction>
          <Button
            variant="outline"
            size="sm"
            nativeButton={false}
            render={<Link href="/instances" />}
          >
            View instances
          </Button>
        </CardAction>
      </CardHeader>

      <CardContent className="space-y-5">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
          <MiniStat
            icon={ServerIcon}
            label="Instances"
            value={`${capacity.activeInstances}/${capacity.maximumInstances}`}
            hint={`min ${capacity.minimumInstances}`}
          />
          <MiniStat
            icon={BoxesIcon}
            label="Warm"
            value={capacity.warmInstances}
            hint={`target ${capacity.minimumWarmInstances}–${capacity.maximumWarmInstances}`}
          />
          <MiniStat
            icon={Layers3Icon}
            label="Reserved"
            value={capacity.reservedInstances}
            hint={
              capacity.pendingWarmInstances > 0
                ? `+${capacity.pendingWarmInstances} starting`
                : undefined
            }
          />
          <MiniStat
            icon={Gamepad2Icon}
            label="Sessions"
            value={activeSessions}
            hint={`${group.sessions.length} tracked`}
          />
          <MiniStat
            icon={UsersIcon}
            label="Players"
            value={players}
            hint={seats > 0 ? `${Math.round(ratio(players, seats))}% of seats` : undefined}
          />
          <MiniStat
            icon={ListOrderedIcon}
            label="Queue"
            value={group.queue.playerCount}
            hint={
              group.queue.oldestJoinedAt
                ? `oldest ${formatAge(group.queue.oldestJoinedAt)}`
                : `${group.queue.partyCount} parties`
            }
          />
        </div>

        <Separator />

        <div className="grid gap-6 lg:grid-cols-2">
          <section className="space-y-3">
            <SectionTitle>
              {group.matchmaking ? "Matchmaking" : "Routing"}
            </SectionTitle>
            {group.matchmaking ? (
              <KeyValueGrid>
                <KeyValue label="Players per match">
                  {group.matchmaking.minimumPlayers}–
                  {group.matchmaking.maximumPlayers}
                </KeyValue>
                <KeyValue label="Teams">
                  {group.matchmaking.teamCount} × {group.matchmaking.teamSize}
                </KeyValue>
                <KeyValue label="Waiting timeout">
                  {formatDuration(group.matchmaking.waitingTimeoutMs)}
                </KeyValue>
                <KeyValue label="Instance wait">
                  {formatDuration(group.matchmaking.instanceWaitTimeoutMs)}
                </KeyValue>
                <KeyValue label="Maximum lobby">
                  {formatDuration(group.matchmaking.maximumWaitingTimeoutMs)}
                </KeyValue>
                <KeyValue label="Candidate window">
                  {group.matchmaking.candidateWindow} tickets
                </KeyValue>
                <KeyValue label="Partial start">
                  min {group.matchmaking.minimumPlayersPerTeam}/team · spread{" "}
                  {group.matchmaking.maximumTeamSpread}
                </KeyValue>
              </KeyValueGrid>
            ) : group.routing ? (
              <KeyValueGrid>
                <KeyValue label="Target per instance">
                  {group.routing.targetPlayersPerInstance}
                </KeyValue>
                <KeyValue label="Maximum per instance">
                  {group.routing.maximumPlayersPerInstance}
                </KeyValue>
              </KeyValueGrid>
            ) : (
              <p className="text-sm text-muted-foreground">
                No matchmaking or routing policy configured.
              </p>
            )}
          </section>

          <section className="space-y-3">
            <SectionTitle>Lifecycle timeouts</SectionTitle>
            <KeyValueGrid columns={3}>
              <KeyValue label="Startup">
                {formatDuration(group.lifecycle.startupTimeoutMs)}
              </KeyValue>
              <KeyValue label="Draining">
                {formatDuration(group.lifecycle.drainingTimeoutMs)}
              </KeyValue>
              <KeyValue label="Shutdown">
                {formatDuration(group.lifecycle.shutdownTimeoutMs)}
              </KeyValue>
            </KeyValueGrid>
          </section>
        </div>

        <section className="space-y-2">
          <SectionTitle count={group.variants.length}>Variants</SectionTitle>
          <div className="overflow-hidden rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="text-xs text-muted-foreground">
                    Variant
                  </TableHead>
                  <TableHead className="text-xs text-muted-foreground">
                    Image
                  </TableHead>
                  <TableHead className="hidden text-xs text-muted-foreground sm:table-cell">
                    Resources
                  </TableHead>
                  <TableHead className="text-right text-xs text-muted-foreground">
                    Weight
                  </TableHead>
                  <TableHead className="text-right text-xs text-muted-foreground">
                    Rev.
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {group.variants.map((variant) => (
                  <TableRow key={variant.id}>
                    <TableCell>
                      <span className="flex items-center gap-2">
                        <span className="font-mono text-xs">{variant.id}</span>
                        {variant.enabled ? null : (
                          <Badge variant="outline" className="text-[0.65rem]">
                            disabled
                          </Badge>
                        )}
                      </span>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {variant.runtime.image}
                    </TableCell>
                    <TableCell className="hidden font-mono text-xs text-muted-foreground sm:table-cell">
                      {variant.runtime.cpu} vCPU ·{" "}
                      {formatBytes(variant.runtime.memoryBytes)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs tabular">
                      {variant.weight}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs text-muted-foreground tabular">
                      {variant.revision}
                    </TableCell>
                  </TableRow>
                ))}
                {group.variants.length === 0 ? (
                  <TableRow className="hover:bg-transparent">
                    <TableCell
                      colSpan={5}
                      className="py-6 text-center text-sm text-muted-foreground"
                    >
                      This group has no variant configured.
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          </div>
        </section>
      </CardContent>
    </Card>
  );
}

export default function GroupsPage() {
  const [search, setSearch] = useState("");

  return (
    <>
      <PageHeader
        title="Groups"
        description="Capacity policies, matchmaking rules and immutable variants loaded at orchestrator startup."
      />
      <ClusterGate>
        {(snapshot) => {
        const needle = search.trim().toLowerCase();
        const groups = snapshot.groups.filter(
          (group) =>
            !needle ||
            group.id.toLowerCase().includes(needle) ||
            group.variants.some((variant) =>
              variant.id.toLowerCase().includes(needle),
            ),
        );

        return (
          <>
            <FilterBar>
              <SearchField
                value={search}
                onChange={setSearch}
                label="Search groups"
                placeholder="Group or variant…"
              />
              <ResultCount
                shown={groups.length}
                total={snapshot.groups.length}
                noun="group"
              />
            </FilterBar>

            <div className="flex flex-col gap-4">
              {groups.map((group) => (
                <GroupCard key={group.id} group={group} />
              ))}
              </div>
            </>
          );
        }}
      </ClusterGate>
    </>
  );
}
