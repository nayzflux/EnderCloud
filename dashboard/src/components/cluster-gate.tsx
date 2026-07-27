"use client";

import { CircleAlertIcon, PlugZapIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useCluster } from "@/components/cluster-provider";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import type { DashboardClusterSnapshot } from "@/lib/contracts";

/**
 * Every page renders from the same shared snapshot, so loading, upstream
 * failures and the "last known good data" fallback are handled in one place.
 */
export function ClusterGate({
  children,
  skeleton,
}: {
  readonly children: (snapshot: DashboardClusterSnapshot) => ReactNode;
  readonly skeleton?: ReactNode;
}) {
  const { snapshot, isPending, isError, error } = useCluster();

  return (
    <>
      {isError ? (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>Synchronisation interrupted</AlertTitle>
          <AlertDescription>
            {snapshot
              ? "Showing the last known snapshot while the dashboard reconnects."
              : (error?.message ?? "The cluster is not responding.")}
          </AlertDescription>
        </Alert>
      ) : null}

      {snapshot ? children(snapshot) : null}

      {!snapshot && isPending ? (skeleton ?? <DefaultSkeleton />) : null}

      {!snapshot && isError ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <PlugZapIcon />
            </EmptyMedia>
            <EmptyTitle>Cluster unreachable</EmptyTitle>
            <EmptyDescription>
              The dashboard keeps retrying automatically. Check that the
              orchestrator is running, or enable <code>DASHBOARD_MOCK_DATA</code>{" "}
              to work against synthetic data.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}
    </>
  );
}

function DefaultSkeleton() {
  return (
    <div className="flex flex-col gap-5">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }, (_unused, index) => (
          <Skeleton key={index} className="h-24 w-full rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-72 w-full rounded-xl" />
      <Skeleton className="h-56 w-full rounded-xl" />
    </div>
  );
}
