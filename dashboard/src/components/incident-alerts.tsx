"use client";

import { useQuery } from "@tanstack/react-query";
import { AlertTriangleIcon, CircleAlertIcon } from "lucide-react";
import Link from "next/link";
import { useCluster } from "@/components/cluster-provider";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { fetchIncidents } from "@/lib/api";

export function OverviewIncidentAlerts() {
  const { refreshInterval, snapshot } = useCluster();
  const activeCount = snapshot?.summary.activeIncidentCount ?? 0;
  const query = useQuery({
    queryKey: ["incidents", "overview"],
    queryFn: () => fetchIncidents({ status: "active", limit: 5 }),
    enabled: activeCount > 0,
    refetchInterval: refreshInterval === 0 ? false : Math.max(5_000, refreshInterval),
    refetchIntervalInBackground: false,
    placeholderData: (previous) => previous,
  });

  if (activeCount === 0) return null;
  if (query.isError) {
    return (
      <Alert variant="destructive">
        <CircleAlertIcon />
        <AlertTitle>{activeCount} active operational incident{activeCount === 1 ? "" : "s"}</AlertTitle>
        <AlertDescription>The incident summary is current, but diagnostic details could not be refreshed.</AlertDescription>
        <AlertAction><InspectButton /></AlertAction>
      </Alert>
    );
  }

  const incidents = query.data?.incidents ?? [];
  const criticalCount = query.data?.criticalCount ?? snapshot?.summary.criticalIncidentCount ?? 0;
  return (
    <Alert variant={criticalCount > 0 ? "destructive" : "default"}>
      <AlertTriangleIcon />
      <AlertTitle>
        {activeCount} active operational incident{activeCount === 1 ? "" : "s"}
        {criticalCount > 0 ? ` · ${criticalCount} critical` : ""}
      </AlertTitle>
      <AlertDescription>
        {incidents.length > 0 ? (
          <ul className="flex flex-col gap-1">
            {incidents.slice(0, 3).map((incident) => (
              <li key={incident.id}>
                <span className="font-mono text-xs">{incident.scope.id}</span>{" "}
                {incident.summary} <span className="font-mono text-xs text-muted-foreground">({incident.cause})</span>
              </li>
            ))}
          </ul>
        ) : "Loading persistent diagnoses…"}
      </AlertDescription>
      <AlertAction><InspectButton /></AlertAction>
    </Alert>
  );
}

function InspectButton() {
  return (
    <Button variant="outline" size="xs" nativeButton={false} render={<Link href="/incidents" />}>
      Inspect
    </Button>
  );
}
