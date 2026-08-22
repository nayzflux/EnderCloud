import { syncClock } from "./clock";
import type {
  DashboardClusterSnapshot,
  DashboardInstanceDetail,
  DashboardQueueDetail,
  DashboardSessionDetail,
  DashboardVariantGraph,
  DashboardMonitoringSeries,
  DashboardMonitoringSummary,
  MonitoringRange,
  DashboardIncidentPage,
  IncidentKind,
  IncidentSeverity,
  VariantStartupStatus,
} from "./contracts";

export class DashboardApiError extends Error {
  public constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "DashboardApiError";
  }
}

async function readJson<T>(path: string): Promise<T> {
  const response = await fetch(path, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;
    throw new DashboardApiError(
      payload?.message ?? "The cluster is not responding.",
      response.status,
    );
  }
  const payload = (await response.json()) as T;
  // Every dashboard payload is stamped with the orchestrator's instant. Doing
  // this here — rather than in an effect — means the shared clock is already
  // corrected by the time React renders the data that came with it.
  syncClock((payload as { generatedAt?: string }).generatedAt);
  return payload;
}

async function postJson<T>(path: string): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;
    throw new DashboardApiError(
      payload?.message ?? "The operation could not be completed.",
      response.status,
    );
  }
  return response.json() as Promise<T>;
}

export function fetchCluster(): Promise<DashboardClusterSnapshot> {
  return readJson("/api/cluster");
}

export function fetchQueue(
  groupId: string,
  limit = 100,
): Promise<DashboardQueueDetail> {
  return readJson(
    `/api/groups/${encodeURIComponent(groupId)}/queue?limit=${limit}`,
  );
}

export function fetchMonitoringSummary(): Promise<DashboardMonitoringSummary> {
  return readJson("/api/monitoring/summary");
}

export function fetchGroupMonitoring(
  groupId: string,
  range: MonitoringRange,
): Promise<DashboardMonitoringSeries> {
  return readJson(
    `/api/groups/${encodeURIComponent(groupId)}/monitoring?range=${range}`,
  );
}

export function fetchVariants(groupId: string): Promise<DashboardVariantGraph> {
  return readJson(`/api/groups/${encodeURIComponent(groupId)}/variants`);
}

export function fetchInstance(
  instanceId: string,
): Promise<DashboardInstanceDetail> {
  return readJson(`/api/instances/${encodeURIComponent(instanceId)}`);
}

export function fetchSession(
  sessionId: string,
): Promise<DashboardSessionDetail> {
  return readJson(`/api/sessions/${encodeURIComponent(sessionId)}`);
}

export function fetchIncidents(filters: {
  readonly status?: "active" | "resolved" | "all";
  readonly severity?: IncidentSeverity;
  readonly kind?: IncidentKind;
  readonly groupId?: string;
  readonly scopeId?: string;
  readonly cursor?: string;
  readonly limit?: number;
} = {}): Promise<DashboardIncidentPage> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined) query.set(key, String(value));
  }
  const suffix = query.size > 0 ? `?${query}` : "";
  return readJson(`/api/incidents${suffix}`);
}

export function drainHost(hostId: string): Promise<{ accepted: boolean }> {
  return postJson(`/api/hosts/${encodeURIComponent(hostId)}/drain`);
}

export function activateHost(hostId: string): Promise<{ accepted: boolean }> {
  return postJson(`/api/hosts/${encodeURIComponent(hostId)}/activate`);
}

export function retryVariantStartup(
  groupId: string,
  variantId: string,
  revision: number,
): Promise<VariantStartupStatus> {
  return postJson(
    `/api/groups/${encodeURIComponent(groupId)}/variants/${encodeURIComponent(variantId)}/revisions/${revision}/startup-retry`,
  );
}
