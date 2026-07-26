import { cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import Docker from "dockerode";
import type { AppConfig } from "../config.ts";
import type { Logger } from "../logger.ts";
import type {
  CreatedInstance,
  Executor,
  InstanceSpec,
  RuntimeInstance,
  RuntimeState,
} from "./executor.ts";

export function instanceName(variantId: string, instanceId: string): string {
  return `endercloud-${variantId}-${instanceId}`;
}

export class LocalDockerExecutor implements Executor {
  private readonly docker: Docker;

  public constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {
    this.docker = new Docker({ socketPath: config.dockerSocket });
  }

  public async createInstance(spec: InstanceSpec): Promise<CreatedInstance> {
    const existing = await this.findByInstanceId(spec.instanceId);
    const runtimePath = join(this.config.runtimeRoot, "instances", spec.instanceId);
    const hostRuntimePath = join(this.config.runtimeHostRoot, "instances", spec.instanceId);
    const name = instanceName(spec.variantId, spec.instanceId);
    if (existing) {
      if (existing.State !== "running") await this.docker.getContainer(existing.Id).start();
      return {
        containerId: existing.Id,
        runtimePath,
        endpoint: `${name}:25565`,
      };
    }

    await mkdir(join(this.config.runtimeRoot, "instances"), { recursive: true });
    await rm(runtimePath, { recursive: true, force: true });
    await cp(spec.templatePath, runtimePath, {
      recursive: true,
      errorOnExist: true,
      force: false,
      verbatimSymlinks: true,
    });
    await this.ensureImage(spec.runtime.image);

    const labels: Record<string, string> = {
      "orchestrator.managed": "true",
      "orchestrator.instance-id": spec.instanceId,
      "orchestrator.group-id": spec.groupId,
      "orchestrator.variant-id": spec.variantId,
    };
    if (spec.sessionId) labels["orchestrator.session-id"] = spec.sessionId;
    const env = {
      ...spec.runtime.environment,
      ...spec.environment,
      ENDERCLOUD_INSTANCE_ID: spec.instanceId,
      ENDERCLOUD_ORCHESTRATOR_URL: this.config.publicUrl,
    };
    const container = await this.docker.createContainer({
      name,
      Image: spec.runtime.image,
      Env: Object.entries(env).map(([key, value]) => `${key}=${value}`),
      Labels: labels,
      ExposedPorts: { "25565/tcp": {} },
      HostConfig: {
        AutoRemove: false,
        Binds: [`${hostRuntimePath}:/data`],
        Memory: spec.runtime.memoryBytes,
        NanoCpus: Math.round(spec.runtime.cpu * 1_000_000_000),
        NetworkMode: this.config.dockerNetwork,
      },
    });
    try {
      await container.start();
    } catch (error) {
      await container.remove({ force: true }).catch(() => undefined);
      throw error;
    }
    this.logger.info("Docker instance started", {
      instanceId: spec.instanceId,
      containerId: container.id,
      image: spec.runtime.image,
    });
    return { containerId: container.id, runtimePath, endpoint: `${name}:25565` };
  }

  public async stopInstance(instanceId: string, timeoutSeconds: number): Promise<void> {
    const existing = await this.findByInstanceId(instanceId);
    if (!existing || existing.State !== "running") return;
    await this.docker.getContainer(existing.Id).stop({ t: timeoutSeconds });
  }

  public async deleteInstance(instanceId: string): Promise<void> {
    const existing = await this.findByInstanceId(instanceId);
    if (existing) {
      await this.docker.getContainer(existing.Id).remove({ force: true, v: true });
    }
    const runtimePath = join(this.config.runtimeRoot, "instances", instanceId);
    await rm(runtimePath, { recursive: true, force: true });
  }

  public async inspectInstance(instanceId: string): Promise<RuntimeState> {
    const existing = await this.findByInstanceId(instanceId);
    if (!existing) return { exists: false, running: false };
    const inspection = await this.docker.getContainer(existing.Id).inspect();
    return {
      exists: true,
      running: inspection.State.Running,
      exitCode: inspection.State.ExitCode,
      status: inspection.State.Status,
    };
  }

  public async listManagedInstances(): Promise<readonly RuntimeInstance[]> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: { label: ["orchestrator.managed=true"] },
    });
    return containers.map((container) => ({
      containerId: container.Id,
      instanceId: container.Labels["orchestrator.instance-id"] ?? "",
      groupId: container.Labels["orchestrator.group-id"] ?? "",
      variantId: container.Labels["orchestrator.variant-id"] ?? "",
      ...(container.Labels["orchestrator.session-id"]
        ? { sessionId: container.Labels["orchestrator.session-id"] }
        : {}),
      running: container.State === "running",
      status: container.Status,
    }));
  }

  private async findByInstanceId(instanceId: string): Promise<Docker.ContainerInfo | undefined> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: {
        label: [
          "orchestrator.managed=true",
          `orchestrator.instance-id=${instanceId}`,
        ],
      },
    });
    return containers[0];
  }

  private async ensureImage(image: string): Promise<void> {
    try {
      await this.docker.getImage(image).inspect();
      return;
    } catch {
      this.logger.info("Pulling Docker image", { image });
    }
    const stream = await this.docker.pull(image);
    await new Promise<void>((resolve, reject) => {
      this.docker.modem.followProgress(stream, (error) =>
        error ? reject(error) : resolve(),
      );
    });
  }
}
