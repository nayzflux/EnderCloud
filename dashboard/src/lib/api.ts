import type {
  DashboardClusterSnapshot,
  DashboardInstanceDetail,
  DashboardQueueDetail,
  DashboardSessionDetail,
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
      payload?.message ?? "Le cluster ne répond pas.",
      response.status,
    );
  }
  return response.json() as Promise<T>;
}

export function fetchCluster(): Promise<DashboardClusterSnapshot> {
  return readJson("/api/cluster");
}

export function fetchQueue(groupId: string): Promise<DashboardQueueDetail> {
  return readJson(`/api/groups/${encodeURIComponent(groupId)}/queue?limit=50`);
}

export function fetchInstance(instanceId: string): Promise<DashboardInstanceDetail> {
  return readJson(`/api/instances/${encodeURIComponent(instanceId)}`);
}

export function fetchSession(sessionId: string): Promise<DashboardSessionDetail> {
  return readJson(`/api/sessions/${encodeURIComponent(sessionId)}`);
}
