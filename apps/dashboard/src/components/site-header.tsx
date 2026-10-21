"use client";

import { RefreshCwIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { refreshIntervals, useCluster } from "@/components/cluster-provider";
import { ThemeToggle } from "@/components/theme-toggle";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { RelativeTime } from "@/components/live-time";
import { cn } from "@/lib/utils";

const pageTitles: Record<string, string> = {
  "": "Overview",
  groups: "Groups",
  instances: "Instances",
  sessions: "Sessions",
  queues: "Queues",
  topology: "Topology",
  monitoring: "Monitoring",
};

function LiveIndicator() {
  const { snapshot, isFetching, isError, refreshInterval } = useCluster();

  const state = isError
    ? "error"
    : refreshInterval === 0
      ? "paused"
      : isFetching
        ? "syncing"
        : "live";

  const labels = {
    live: "Live",
    syncing: "Syncing",
    paused: "Paused",
    error: "Stale",
  } as const;

  const dotClass = {
    live: "bg-success",
    syncing: "bg-info animate-pulse",
    paused: "bg-muted-foreground",
    error: "bg-destructive",
  } as const;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div className="flex h-7 items-center gap-2 rounded-lg border px-2.5 text-xs" />
        }
      >
        <span
          aria-hidden
          className={cn("size-1.5 shrink-0 rounded-full", dotClass[state])}
        />
        <span className="font-medium">{labels[state]}</span>
        <span className="hidden text-muted-foreground sm:inline tabular">
          {snapshot ? <RelativeTime value={snapshot.generatedAt} /> : "—"}
        </span>
      </TooltipTrigger>
      <TooltipContent>
        {snapshot ? (
          <>
            Snapshot generated <RelativeTime value={snapshot.generatedAt} />
          </>
        ) : (
          "Waiting for the first snapshot"
        )}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Snapshot-driven controls live in their own components: the header re-renders
 * on navigation only, so an open menu is never disturbed by a refresh tick.
 */
function RefreshControls() {
  const { refresh, isFetching, refreshInterval, setRefreshInterval } =
    useCluster();

  return (
    <>
      <Select
        items={refreshIntervals.map((interval) => ({
          value: String(interval.value),
          label: interval.label,
        }))}
        value={String(refreshInterval)}
        onValueChange={(value) => setRefreshInterval(Number(value ?? 5_000))}
      >
        <SelectTrigger
          size="sm"
          aria-label="Auto-refresh interval"
          className="hidden w-24 sm:flex"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent alignItemWithTrigger={false} align="end">
          <SelectGroup>
            {refreshIntervals.map((interval) => (
              <SelectItem key={interval.value} value={String(interval.value)}>
                {interval.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>

      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Refresh now"
              disabled={isFetching}
              onClick={refresh}
            />
          }
        >
          <RefreshCwIcon className={cn(isFetching && "animate-spin")} />
        </TooltipTrigger>
        <TooltipContent>Refresh now</TooltipContent>
      </Tooltip>
    </>
  );
}

export function SiteHeader() {
  const pathname = usePathname();

  const segment = pathname.split("/")[1] ?? "";
  const title = pageTitles[segment] ?? "Overview";

  return (
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b bg-background/80 px-3 backdrop-blur-sm">
      <SidebarTrigger className="-ml-1" />
      {/* The primitive stretches vertical separators, so auto margins re-centre
          the fixed-height rule inside the header. */}
      <Separator orientation="vertical" className="mr-1 my-auto h-4" />

      <Breadcrumb className="min-w-0">
        <BreadcrumbList className="flex-nowrap">
          <BreadcrumbItem className="hidden sm:inline-flex">
            <BreadcrumbLink render={<Link href="/" />}>EnderCloud</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator className="hidden sm:inline-flex" />
          <BreadcrumbItem>
            <BreadcrumbPage className="truncate">{title}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <div className="ml-auto flex items-center gap-2">
        <LiveIndicator />
        <RefreshControls />
        <ThemeToggle />
      </div>
    </header>
  );
}
