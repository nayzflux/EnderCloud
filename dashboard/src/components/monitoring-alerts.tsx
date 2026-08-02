"use client";

import { useQuery } from "@tanstack/react-query";
import { ActivityIcon, GaugeIcon } from "lucide-react";
import Link from "next/link";
import { useCluster } from "@/components/cluster-provider";
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { fetchMonitoringSummary } from "@/lib/api";

export function OverviewMonitoringAlerts() {
  const { refreshInterval } = useCluster();
  const query = useQuery({
    queryKey: ["monitoring-summary"],
    queryFn: fetchMonitoringSummary,
    refetchInterval:
      refreshInterval === 0 ? false : Math.max(30_000, refreshInterval),
    refetchIntervalInBackground: false,
    placeholderData: (previous) => previous,
  });

  if (query.isError) {
    return (
      <Alert>
        <ActivityIcon />
        <AlertTitle>Performance monitoring unavailable</AlertTitle>
        <AlertDescription>
          Cluster state remains live, but performance alerts could not be refreshed.
        </AlertDescription>
      </Alert>
    );
  }

  const alerts = query.data?.alerts ?? [];
  if (alerts.length === 0) return null;

  return (
    <Alert variant="destructive">
      <GaugeIcon />
      <AlertTitle>
        {alerts.length} performance alert{alerts.length === 1 ? "" : "s"}
      </AlertTitle>
      <AlertDescription>
        <ul className="flex flex-col gap-1">
          {alerts.map((alert) => (
            <li key={`${alert.metric}:${alert.groupId}:${alert.variantId}`}>
              <span className="font-mono text-xs">{alert.groupId}/{alert.variantId}</span>{" "}
              {alert.metric === "TPS_5M"
                ? `is averaging ${alert.value.toFixed(2)} TPS over 5 minutes.`
                : `is taking ${(alert.valueMs / 1_000).toFixed(1)}s to boot over the last hour.`}
            </li>
          ))}
        </ul>
      </AlertDescription>
      <AlertAction>
        <Button
          variant="outline"
          size="xs"
          nativeButton={false}
          render={<Link href="/monitoring" />}
        >
          Inspect
        </Button>
      </AlertAction>
    </Alert>
  );
}
