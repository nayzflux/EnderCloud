"use client";

import { Elapsed } from "@/components/live-time";
import { Badge } from "@/components/ui/badge";
import type { DashboardInstance } from "@endercloud/contracts";

export function ProxyStatus({ instance }: { readonly instance: DashboardInstance }) {
  if (!instance.proxy) return null;
  return (
    <div className="flex flex-col gap-1">
      <Badge variant="outline">
        {instance.proxy.acceptingConnections ? "Accepting connections" : "Admissions closed"}
      </Badge>
      <span className="text-xs text-muted-foreground">
        {instance.proxy.lastHeartbeatAt ? (
          <>
            Heartbeat <Elapsed value={instance.proxy.lastHeartbeatAt} /> ago
          </>
        ) : (
          "Awaiting heartbeat"
        )}
      </span>
    </div>
  );
}
