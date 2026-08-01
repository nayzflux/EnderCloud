import { syncClock } from "./clock";
import type {
  DashboardClusterSnapshot,
  DashboardInstanceDetail,
  DashboardQueueDetail,
  DashboardSessionDetail,
  DashboardVariantGraph,
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
