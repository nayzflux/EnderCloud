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
} from "@endercloud/contracts";

export { HttpResponseError as DashboardApiError } from "@endercloud/contracts/http";
import { requestJson } from "@endercloud/contracts/http";
async function readJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const payload = await requestJson<T>(path, { signal });
  if (typeof payload === "object" && payload !== null && "generatedAt" in payload && typeof payload.generatedAt === "string") syncClock(payload.generatedAt);
  return payload;
}
function postJson<T>(path: string): Promise<T> { return requestJson(path, {method: "POST"}); }

export function fetchCluster(context?: {signal?: AbortSignal}): Promise<DashboardClusterSnapshot> {
  return readJson("/api/cluster", context?.signal);
}

export function fetchQueue(
  groupId: string,
  limit = 100,
  signal?: AbortSignal,
): Promise<DashboardQueueDetail> {
  return readJson(
    `/api/groups/${encodeURIComponent(groupId)}/queue?limit=${limit}`, signal,
  );
}

export function fetchMonitoringSummary(context?: {signal?: AbortSignal}): Promise<DashboardMonitoringSummary> {
  return readJson("/api/monitoring/summary", context?.signal);
}

export function fetchGroupMonitoring(
  groupId: string,
  range: MonitoringRange,
  signal?: AbortSignal,
): Promise<DashboardMonitoringSeries> {
  return readJson(
    `/api/groups/${encodeURIComponent(groupId)}/monitoring?range=${range}`, signal,
  );
}

export function fetchVariants(groupId: string, signal?: AbortSignal): Promise<DashboardVariantGraph> {
  return readJson(`/api/groups/${encodeURIComponent(groupId)}/variants`, signal);
}

export function fetchInstance(
  instanceId: string,
  signal?: AbortSignal,
): Promise<DashboardInstanceDetail> {
  return readJson(`/api/instances/${encodeURIComponent(instanceId)}`, signal);
}

export function fetchSession(
  sessionId: string,
  signal?: AbortSignal,
): Promise<DashboardSessionDetail> {
  return readJson(`/api/sessions/${encodeURIComponent(sessionId)}`, signal);
}

export function fetchIncidents(filters: {
  readonly status?: "active" | "resolved" | "all";
  readonly severity?: IncidentSeverity;
  readonly kind?: IncidentKind;
  readonly groupId?: string;
  readonly scopeId?: string;
  readonly cursor?: string;
  readonly limit?: number;
} = {}, signal?: AbortSignal): Promise<DashboardIncidentPage> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined) query.set(key, String(value));
  }
  const suffix = query.size > 0 ? `?${query}` : "";
  return readJson(`/api/incidents${suffix}`, signal);
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
