import { cp, mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import Docker from "dockerode";
import type { Logger } from "../logger.ts";
import type {
  CreatedInstance,
  Executor,
  InstanceSpec,
  InstanceTarget,
  OrphanCleanupResult,
  RuntimeInstance,
  RuntimeState,
} from "./executor.ts";

export interface LocalDockerConfig {
  readonly dockerSocket: string;
  readonly dockerNetwork: string;
  readonly runtimeRoot: string;
  readonly runtimeHostRoot: string;
  readonly publicUrl: string;
  readonly hostId: string;
  readonly gameAddress: string;
  readonly portStart: number;
  readonly portEnd: number;
}

function isDockerNotFound(error: unknown): boolean {
  return typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    error.statusCode === 404;
}

export function instanceName(variantId: string, instanceId: string): string {
  return `endercloud-${variantId}-${instanceId}`;
}

export function firstAvailablePort(
  start: number,
  end: number,
  used: ReadonlySet<number>,
): number | null {
  for (let port = start; port <= end; port += 1) {
    if (!used.has(port)) return port;
  }
  return null;
}

export function decodeDockerLogBuffer(buffer: Buffer): Buffer {
  const chunks: Buffer[] = [];
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const stream = buffer[offset];
    if ((stream !== 0 && stream !== 1 && stream !== 2) ||
      buffer[offset + 1] !== 0 || buffer[offset + 2] !== 0 || buffer[offset + 3] !== 0) {
      return buffer;
    }
    const length = buffer.readUInt32BE(offset + 4);
    const frameEnd = offset + 8 + length;
    if (frameEnd > buffer.length) return buffer;
    chunks.push(buffer.subarray(offset + 8, frameEnd));
    offset = frameEnd;
  }
  return chunks.length > 0 && offset === buffer.length ? Buffer.concat(chunks) : buffer;
}

export async function materializeLayers(
  layers: InstanceSpec["templateLayers"],
  destination: string,
): Promise<void> {
  for (const layer of layers) {
    if (!layer.templatePath) throw new Error(`Layer ${layer.id} has no local template path`);
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
  private creationQueue: Promise<void> = Promise.resolve();

  public constructor(
    private readonly config: LocalDockerConfig,
    private readonly logger: Logger,
  ) {
    this.docker = new Docker({ socketPath: config.dockerSocket });
  }

  // Materialize a template, create its container, and return the proxy endpoint.
  public async createInstance(spec: InstanceSpec): Promise<CreatedInstance> {
    const startedAt = performance.now();
    this.assertHost(spec.hostId);
    const existing = await this.findByInstanceId(spec.instanceId);
    const runtimePath = join(this.config.runtimeRoot, "instances", spec.instanceId);
    const hostRuntimePath = join(this.config.runtimeHostRoot, "instances", spec.instanceId);
    const name = instanceName(spec.variantId, spec.instanceId);
    if (existing) {
      // Reuse the labeled container to make CREATE safe to retry after crashes.
      if (existing.State !== "running") await this.docker.getContainer(existing.Id).start();
      this.logger.debug("docker.instance.reused", "Existing managed container reused", {
        instanceId: spec.instanceId,
        containerId: existing.Id,
      });
      return {
        containerId: existing.Id,
        runtimePath,
        endpoint: `${this.config.gameAddress}:${this.portFromContainer(existing)}`,
      };
    }

    // Rebuild runtime data from the immutable template to avoid leftovers from failed attempts.
    const materializationStartedAt = performance.now();
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
    this.logger.debug("docker.runtime.materialized", "Instance runtime materialized", {
      instanceId: spec.instanceId,
      durationMs: Math.round(performance.now() - materializationStartedAt),
      layerCount: spec.templateLayers.length,
    });
    await this.ensureImage(spec.runtime.image);
    // Only port selection and container creation need serialization. Runtime
    // materialization and image checks remain concurrent across startup slots.
    const prepared = await this.withCreationLock(async () => {
      const concurrentExisting = await this.findByInstanceId(spec.instanceId);
      if (concurrentExisting) return { existing: concurrentExisting } as const;
      const hostPort = await this.allocatePort();
      this.logger.debug("docker.port.allocated", "Game port allocated", {
        instanceId: spec.instanceId,
        hostPort,
      });
      const labels: Record<string, string> = {
        "orchestrator.managed": "true",
        "orchestrator.instance-id": spec.instanceId,
        "orchestrator.group-id": spec.groupId,
        "orchestrator.variant-id": spec.variantId,
        "orchestrator.host-id": spec.hostId,
        "orchestrator.host-port": String(hostPort),
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
          PortBindings: {
            "25565/tcp": [{ HostIp: "0.0.0.0", HostPort: String(hostPort) }],
          },
        },
      });
      return { container, hostPort } as const;
    });
    if ("existing" in prepared) {
      if (prepared.existing.State !== "running") {
        await this.docker.getContainer(prepared.existing.Id).start();
      }
      return {
        containerId: prepared.existing.Id,
        runtimePath,
        endpoint: `${this.config.gameAddress}:${this.portFromContainer(prepared.existing)}`,
      };
    }
    const { container, hostPort } = prepared;
    try {
      await container.start();
    } catch (error) {
      // Creation succeeded but startup failed; remove the unusable container before retrying.
      await container.remove({ force: true }).catch(() => undefined);
      throw error;
    }
    this.logger.info("docker.instance.started", "Docker instance started", {
      instanceId: spec.instanceId,
      containerId: container.id,
      image: spec.runtime.image,
      hostPort,
      durationMs: Math.round(performance.now() - startedAt),
    });
    return {
      containerId: container.id,
      runtimePath,
      endpoint: `${this.config.gameAddress}:${hostPort}`,
    };
  }

  private async withCreationLock<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.creationQueue.then(operation);
    this.creationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  // Gracefully stop a managed container when it is still running.
  public async stopInstance(target: InstanceTarget, timeoutSeconds: number): Promise<void> {
    this.assertHost(target.hostId);
    const existing = await this.findByInstanceId(target.instanceId);
    if (!existing || existing.State !== "running") return;
    await this.docker.getContainer(existing.Id).stop({ t: timeoutSeconds });
  }

  // Remove both the managed container and its generated runtime directory.
  public async deleteInstance(target: InstanceTarget): Promise<void> {
    this.assertHost(target.hostId);
    const existing = await this.findByInstanceId(target.instanceId);
    if (existing) {
      await this.docker.getContainer(existing.Id).remove({ force: true, v: true });
    }
    const runtimePath = this.safeOrphanRuntimePath(target.instanceId);
    if (!runtimePath) {
      throw new Error(`Refusing to delete unsafe runtime path for ${target.instanceId}`);
    }
    await rm(runtimePath, { recursive: true, force: true });
  }

  public async getInstanceLogs(
    target: InstanceTarget,
    lines: number,
    maxBytes: number,
  ): Promise<string> {
    this.assertHost(target.hostId);
    const existing = await this.findByInstanceId(target.instanceId);
    if (!existing) return "";
    const output = await this.docker.getContainer(existing.Id).logs({
      stdout: true,
      stderr: true,
      follow: false,
      tail: Math.max(1, Math.min(lines, 1_000)),
    });
    const raw = Buffer.isBuffer(output) ? output : Buffer.from(String(output));
    const buffer = decodeDockerLogBuffer(raw);
    return buffer.subarray(Math.max(0, buffer.length - Math.max(1, maxBytes)))
      .toString("utf8")
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
  }

  // Delete the exact Docker object observed by reconciliation, then clean its safe runtime path.
  public async deleteOrphanInstance(
    instance: RuntimeInstance,
  ): Promise<OrphanCleanupResult> {
    this.assertHost(instance.hostId);
    const container = this.docker.getContainer(instance.containerId);
    let containerRemoved = false;
    try {
      const inspection = await container.inspect();
      const labels = inspection.Config.Labels ?? {};
      const inspectedInstanceId = labels["orchestrator.instance-id"] ?? "";
      if (
        labels["orchestrator.managed"] !== "true" ||
        inspectedInstanceId !== instance.instanceId ||
        labels["orchestrator.host-id"] !== this.config.hostId
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
      this.logger.warn("docker.runtime.cleanup_refused", "Skipped unsafe orphan runtime directory cleanup", {
        instanceId: instance.instanceId,
        containerId: instance.containerId,
      });
      return { containerRemoved, runtimeDirectoryRemoved: false };
    }
    await rm(runtimePath, { recursive: true, force: true });
    return { containerRemoved, runtimeDirectoryRemoved: true };
  }

  // Read the runtime state used by reconciliation and diagnostics.
  public async inspectInstance(target: InstanceTarget): Promise<RuntimeState> {
    this.assertHost(target.hostId);
    const existing = await this.findByInstanceId(target.instanceId);
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
  public async listManagedInstances(hostId: string): Promise<readonly RuntimeInstance[]> {
    this.assertHost(hostId);
    const containers = await this.docker.listContainers({
      all: true,
      filters: {
        label: [
          "orchestrator.managed=true",
          `orchestrator.host-id=${this.config.hostId}`,
        ],
      },
    });
    // Normalize Docker's shape into the executor contract consumed by reconciliation.
    return containers.map((container) => ({
      hostId: container.Labels["orchestrator.host-id"] ?? this.config.hostId,
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
          `orchestrator.host-id=${this.config.hostId}`,
        ],
      },
    });
    return containers[0];
  }

  private assertHost(hostId: string): void {
    if (hostId !== this.config.hostId) {
      throw new Error(`Agent ${this.config.hostId} does not own host ${hostId}`);
    }
  }

  private portFromContainer(container: Docker.ContainerInfo): number {
    const raw = container.Labels["orchestrator.host-port"];
    const port = raw ? Number.parseInt(raw, 10) : Number.NaN;
    if (!Number.isInteger(port)) {
      throw new Error(`Managed container ${container.Id} has no host port label`);
    }
    return port;
  }

  private async allocatePort(): Promise<number> {
    const containers = await this.docker.listContainers({ all: true });
    const used = new Set<number>();
    for (const container of containers) {
      for (const port of container.Ports ?? []) {
        if (port.PublicPort !== undefined) used.add(port.PublicPort);
      }
      const labeled = container.Labels["orchestrator.host-port"];
      if (labeled) used.add(Number.parseInt(labeled, 10));
    }
    const port = firstAvailablePort(this.config.portStart, this.config.portEnd, used);
    if (port !== null) return port;
    throw new Error(
      `No game port is available in ${this.config.portStart}-${this.config.portEnd}`,
    );
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
      this.logger.info("docker.image.pull_started", "Pulling Docker image", { image });
    }
    const stream = await this.docker.pull(image);
    await new Promise<void>((resolve, reject) => {
      this.docker.modem.followProgress(stream, (error) =>
        error ? reject(error) : resolve(),
      );
    });
    this.logger.info("docker.image.pull_completed", "Docker image pull completed", { image });
  }
}
