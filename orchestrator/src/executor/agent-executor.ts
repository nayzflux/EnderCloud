import type { HostService } from "../services/host-service.ts";
import type {
  CreatedInstance,
  Executor,
  InstanceSpec,
  InstanceTarget,
  OrphanCleanupResult,
  RuntimeInstance,
  RuntimeState,
} from "./executor.ts";

export interface AgentExecutorConfig {
  readonly operationTimeoutMs: number;
  readonly probeTimeoutMs: number;
}

export class AgentExecutor implements Executor {
  public constructor(
    private readonly hosts: HostService,
    private readonly config: AgentExecutorConfig,
  ) {}

  public async createInstance(spec: InstanceSpec): Promise<CreatedInstance> {
    return this.request<CreatedInstance>(
      spec.hostId,
      `/api/v1/instances/${encodeURIComponent(spec.instanceId)}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(spec),
      },
      this.config.operationTimeoutMs,
    );
  }

  public async stopInstance(target: InstanceTarget, timeoutSeconds: number): Promise<void> {
    await this.request(
      target.hostId,
      `/api/v1/instances/${encodeURIComponent(target.instanceId)}/stop`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ timeoutSeconds }),
      },
      Math.max(this.config.probeTimeoutMs, timeoutSeconds * 1_000 + 5_000),
    );
  }

  public async deleteInstance(target: InstanceTarget): Promise<void> {
    await this.request(
      target.hostId,
      `/api/v1/instances/${encodeURIComponent(target.instanceId)}`,
      { method: "DELETE" },
      this.config.operationTimeoutMs,
    );
  }

  public async deleteOrphanInstance(instance: RuntimeInstance): Promise<OrphanCleanupResult> {
    return this.request<OrphanCleanupResult>(
      instance.hostId,
      `/api/v1/instances/${encodeURIComponent(instance.instanceId)}`,
      {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ containerId: instance.containerId }),
      },
      this.config.operationTimeoutMs,
    );
  }

  public async inspectInstance(target: InstanceTarget): Promise<RuntimeState> {
    return this.request<RuntimeState>(
      target.hostId,
      `/api/v1/instances/${encodeURIComponent(target.instanceId)}`,
      undefined,
      this.config.probeTimeoutMs,
    );
  }

  public async listManagedInstances(hostId: string): Promise<readonly RuntimeInstance[]> {
    return this.request<readonly RuntimeInstance[]>(
      hostId,
      "/api/v1/instances",
      undefined,
      this.config.probeTimeoutMs,
    );
  }

  private async request<T = unknown>(
    hostId: string,
    path: string,
    init?: RequestInit,
    timeoutMs = this.config.probeTimeoutMs,
  ): Promise<T> {
    const host = await this.hosts.getTarget(hostId);
    const url = new URL(path, host.controlUrl);
    try {
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        const message = await response.text();
        throw new Error(
          `Agent ${hostId} returned ${response.status}${message ? `: ${message}` : ""}`,
        );
      }
      await this.hosts.recordControlSuccess(hostId);
      if (response.status === 204) return undefined as T;
      return await response.json() as T;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.hosts.recordControlFailure(hostId, message).catch(() => undefined);
      throw new Error(`Execution host ${hostId} is unavailable: ${message}`);
    }
  }
}
