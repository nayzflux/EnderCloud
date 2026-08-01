import { cp, mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import Docker from "dockerode";
import type { AppConfig } from "../config.ts";
import type { Logger } from "../logger.ts";
import type {
  CreatedInstance,
  Executor,
  InstanceSpec,
  OrphanCleanupResult,
  RuntimeInstance,
  RuntimeState,
} from "./executor.ts";

function isDockerNotFound(error: unknown): boolean {
  return typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    error.statusCode === 404;
}

export function instanceName(variantId: string, instanceId: string): string {
  return `endercloud-${variantId}-${instanceId}`;
}

export async function materializeLayers(
  layers: InstanceSpec["templateLayers"],
  destination: string,
): Promise<void> {
  for (const layer of layers) {
    for (const entry of await readdir(layer.templatePath, { withFileTypes: true })) {
      if (entry.name === "variant.yml") continue;
      await cp(
        join(layer.templatePath, entry.name),
        join(destination, entry.name),
        {
          recursive: true,
          force: true,
          errorOnExist: false,
          verbatimSymlinks: true,
        },
      );
    }
  }
}

export class LocalDockerExecutor implements Executor {
  private readonly docker: Docker;

  public constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {
    this.docker = new Docker({ socketPath: config.dockerSocket });
  }

  // Materialize a template, create its container, and return the proxy endpoint.
  public async createInstance(spec: InstanceSpec): Promise<CreatedInstance> {
    const existing = await this.findByInstanceId(spec.instanceId);
    const runtimePath = join(this.config.runtimeRoot, "instances", spec.instanceId);
    const hostRuntimePath = join(this.config.runtimeHostRoot, "instances", spec.instanceId);
    const name = instanceName(spec.variantId, spec.instanceId);
    if (existing) {
      // Reuse the labeled container to make CREATE safe to retry after crashes.
      if (existing.State !== "running") await this.docker.getContainer(existing.Id).start();
      return {
        containerId: existing.Id,
        runtimePath,
        endpoint: `${name}:25565`,
      };
    }

    // Rebuild runtime data from the immutable template to avoid leftovers from failed attempts.
    const instancesRoot = join(this.config.runtimeRoot, "instances");
    await mkdir(instancesRoot, { recursive: true });
    const stagingPath = await mkdtemp(join(instancesRoot, `${spec.instanceId}-staging-`));
    try {
      await materializeLayers(spec.templateLayers, stagingPath);
      await rm(runtimePath, { recursive: true, force: true });
      await rename(stagingPath, runtimePath);
    } catch (error) {
      await rm(stagingPath, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    await this.ensureImage(spec.runtime.image);

    // Labels are the durable ownership metadata used for discovery after orchestrator restarts.
    const labels: Record<string, string> = {
      "orchestrator.managed": "true",
      "orchestrator.instance-id": spec.instanceId,
      "orchestrator.group-id": spec.groupId,
      "orchestrator.variant-id": spec.variantId,
    };
    if (spec.sessionId) labels["orchestrator.session-id"] = spec.sessionId;
    // Explicit request values override variant defaults, then orchestrator identity is enforced.
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
      // Creation succeeded but startup failed; remove the unusable container before retrying.
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

  // Gracefully stop a managed container when it is still running.
  public async stopInstance(instanceId: string, timeoutSeconds: number): Promise<void> {
    const existing = await this.findByInstanceId(instanceId);
    if (!existing || existing.State !== "running") return;
    await this.docker.getContainer(existing.Id).stop({ t: timeoutSeconds });
  }

  // Remove both the managed container and its generated runtime directory.
  public async deleteInstance(instanceId: string): Promise<void> {
    const existing = await this.findByInstanceId(instanceId);
    if (existing) {
      await this.docker.getContainer(existing.Id).remove({ force: true, v: true });
    }
    const runtimePath = join(this.config.runtimeRoot, "instances", instanceId);
    await rm(runtimePath, { recursive: true, force: true });
  }

  // Delete the exact Docker object observed by reconciliation, then clean its safe runtime path.
  public async deleteOrphanInstance(
    instance: RuntimeInstance,
  ): Promise<OrphanCleanupResult> {
    const container = this.docker.getContainer(instance.containerId);
    let containerRemoved = false;
    try {
      const inspection = await container.inspect();
      const labels = inspection.Config.Labels ?? {};
      const inspectedInstanceId = labels["orchestrator.instance-id"] ?? "";
      if (
        labels["orchestrator.managed"] !== "true" ||
        inspectedInstanceId !== instance.instanceId
      ) {
        throw new Error(
          `Refusing to delete Docker container ${instance.containerId}: ownership labels changed`,
        );
      }
      await container.remove({ force: true, v: true });
      containerRemoved = true;
    } catch (error) {
      // A container disappearing after the reconciliation snapshot is already converged.
      if (!isDockerNotFound(error)) throw error;
    }

    const runtimePath = this.safeOrphanRuntimePath(instance.instanceId);
    if (!runtimePath) {
      this.logger.warn("Skipped unsafe orphan runtime directory cleanup", {
        instanceId: instance.instanceId,
        containerId: instance.containerId,
      });
      return { containerRemoved, runtimeDirectoryRemoved: false };
    }
    await rm(runtimePath, { recursive: true, force: true });
    return { containerRemoved, runtimeDirectoryRemoved: true };
  }

  // Read the runtime state used by reconciliation and diagnostics.
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

  // Discover only containers owned by this orchestrator through Docker labels.
  public async listManagedInstances(): Promise<readonly RuntimeInstance[]> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: { label: ["orchestrator.managed=true"] },
    });
    // Normalize Docker's shape into the executor contract consumed by reconciliation.
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

  // Resolve a managed container by its stable orchestrator instance identifier.
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

  private safeOrphanRuntimePath(instanceId: string): string | undefined {
    if (!instanceId) return undefined;
    const instancesRoot = resolve(this.config.runtimeRoot, "instances");
    const runtimePath = resolve(instancesRoot, instanceId);
    const relativePath = relative(instancesRoot, runtimePath);
    if (
      !relativePath ||
      isAbsolute(relativePath) ||
      relativePath.startsWith("..") ||
      basename(relativePath) !== relativePath
    ) {
      return undefined;
    }
    return runtimePath;
  }

  // Pull the configured image only when it is not already available locally.
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
