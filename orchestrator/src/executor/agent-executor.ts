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
import { ExecutionHostUnavailableError } from "./executor.ts";
import { nanoid } from "../id.ts";
import type { Logger } from "../logger.ts";

export interface AgentExecutorConfig {
  readonly operationTimeoutMs: number;
  readonly probeTimeoutMs: number;
}

class AgentResponseError extends Error {
  public constructor(readonly status: number, message: string) {
    super(message);
    this.name = "AgentResponseError";
  }
}

export class AgentExecutor implements Executor {
  private readonly shutdown = new AbortController();

  public constructor(
    private readonly hosts: HostService,
    private readonly config: AgentExecutorConfig,
    private readonly logger?: Logger,
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

  public async getInstanceLogs(
    target: InstanceTarget,
    lines: number,
    maxBytes: number,
  ): Promise<string> {
    const query = new URLSearchParams({ lines: String(lines), maxBytes: String(maxBytes) });
    const result = await this.request<{ readonly logs: string }>(
      target.hostId,
      `/api/v1/instances/${encodeURIComponent(target.instanceId)}/logs?${query}`,
      undefined,
      this.config.probeTimeoutMs,
    );
    return result.logs;
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

  public cancelPending(): void {
    this.shutdown.abort(new Error("Orchestrator is shutting down"));
  }

  private async request<T = unknown>(
    hostId: string,
    path: string,
    init?: RequestInit,
    timeoutMs = this.config.probeTimeoutMs,
  ): Promise<T> {
    const host = await this.hosts.getTarget(hostId);
    const url = new URL(path, host.controlUrl);
    const startedAt = performance.now();
    const context = this.logger?.currentContext() ?? {};
    const requestId = typeof context.requestId === "string" ? context.requestId : nanoid();
    const headers = new Headers(init?.headers);
    headers.set("x-request-id", requestId);
    if (typeof context.commandId === "string") headers.set("x-command-id", context.commandId);
    try {
      const response = await fetch(url, {
        ...init,
        headers,
        signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), this.shutdown.signal]),
      });
      await this.hosts.recordControlSuccess(hostId);
      if (!response.ok) {
        const message = await response.text();
        if (response.status >= 500) {
          this.logger?.error("executor.request.server_error", "Execution agent returned a server error", {
            requestId,
            hostId,
            method: init?.method ?? "GET",
            path: url.pathname,
            status: response.status,
            durationMs: Math.round(performance.now() - startedAt),
            outcome: "failure",
          });
        }
        throw new AgentResponseError(
          response.status,
          `Agent ${hostId} returned ${response.status}${message ? `: ${message}` : ""}`,
        );
      }
      this.logger?.debug("executor.request.completed", "Execution agent request completed", {
        requestId,
        hostId,
        method: init?.method ?? "GET",
        path: url.pathname,
        status: response.status,
        durationMs: Math.round(performance.now() - startedAt),
        outcome: "success",
      });
      if (response.status === 204) return undefined as T;
      return await response.json() as T;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof AgentResponseError) {
        this.logger?.debug("executor.request.failed", "Execution agent rejected a request", {
          requestId,
          hostId,
          method: init?.method ?? "GET",
          path: url.pathname,
          status: error.status,
          durationMs: Math.round(performance.now() - startedAt),
          outcome: "failure",
          error,
        });
        throw error;
      }
      await this.hosts.recordControlFailure(hostId, message).catch(() => undefined);
      this.logger?.debug("executor.request.failed", "Execution agent request failed", {
        requestId,
        hostId,
        method: init?.method ?? "GET",
        path: url.pathname,
        durationMs: Math.round(performance.now() - startedAt),
        outcome: "failure",
        error,
      });
      throw new ExecutionHostUnavailableError(hostId, message, error);
    }
  }
}
