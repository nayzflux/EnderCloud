import { expect, mock, test } from "bun:test";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "../../src/config.ts";
import type { RuntimeInstance } from "../../src/executor/executor.ts";
import { instanceName, LocalDockerExecutor } from "../../src/executor/local-docker.ts";
import type { Logger } from "../../src/logger.ts";

function config(runtimeRoot: string): AppConfig {
  return {
    databaseUrl: "postgres://localhost/endercloud",
    redisUrl: "redis://localhost:6379",
    port: 8080,
    publicUrl: "http://orchestrator:8080",
    dockerSocket: "/var/run/docker.sock",
    dockerNetwork: "endercloud",
    groupsRoot: "/groups",
    templatesRoot: "/templates",
    runtimeRoot,
    runtimeHostRoot: runtimeRoot,
    capacityIntervalMs: 5_000,
    matchmakingIntervalMs: 1_000,
    reconcileIntervalMs: 15_000,
    legacyTransferTimeoutMs: 20_000,
    legacyCancelledDrainTimeoutMs: 10_000,
    legacyTransferTimeoutConfigured: false,
    legacyCancelledDrainTimeoutConfigured: false,
    maxInstanceRetries: 2,
    logLevel: "info",
  };
}

function runtime(instanceId: string, containerId = "target-container"): RuntimeInstance {
  return {
    instanceId,
    containerId,
    groupId: "group",
    variantId: "variant",
    running: true,
    status: "Up",
  };
}

function executorWithDocker(
  runtimeRoot: string,
  instance: RuntimeInstance,
  removeContainer = mock(async () => {}),
  inspectedInstanceId = instance.instanceId,
) {
  const warnings: unknown[] = [];
  const logger = {
    warn: (...args: unknown[]) => warnings.push(args),
  } as unknown as Logger;
  const executor = new LocalDockerExecutor(config(runtimeRoot), logger);
  const getContainer = mock((containerId: string) => ({
    inspect: mock(async () => ({
      Config: {
        Labels: {
          "orchestrator.managed": "true",
          "orchestrator.instance-id": inspectedInstanceId,
        },
      },
    })),
    remove: removeContainer,
  }));
  Object.defineProperty(executor, "docker", { value: { getContainer } });
  return { executor, getContainer, removeContainer, warnings };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test("Docker instance names include the variant and unique instance id", () => {
  expect(
    instanceName(
      "skywars-solo-japan",
      "aB3dE5fG7hJ9kL2m",
    ),
  ).toBe(
    "endercloud-skywars-solo-japan-aB3dE5fG7hJ9kL2m",
  );
});

test("orphan cleanup removes the exact observed container and its runtime directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "endercloud-orphan-"));
  try {
    const orphan = runtime("aB3dE5fG7hJ9kL2m");
    const runtimePath = join(root, "instances", orphan.instanceId);
    await mkdir(runtimePath, { recursive: true });
    await writeFile(join(runtimePath, "server.properties"), "motd=test");
    const { executor, getContainer, removeContainer } = executorWithDocker(root, orphan);

    const result = await executor.deleteOrphanInstance(orphan);

    expect(getContainer).toHaveBeenCalledWith("target-container");
    expect(removeContainer).toHaveBeenCalledWith({ force: true, v: true });
    expect(result).toEqual({ containerRemoved: true, runtimeDirectoryRemoved: true });
    expect(await exists(runtimePath)).toBeFalse();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("orphan cleanup never removes a runtime path outside the instances directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "endercloud-orphan-"));
  try {
    const unsafeId = join("..", "outside");
    const orphan = runtime(unsafeId);
    const outsidePath = join(root, "outside");
    await mkdir(outsidePath, { recursive: true });
    await writeFile(join(outsidePath, "keep.txt"), "keep");
    const { executor, warnings } = executorWithDocker(root, orphan);

    const result = await executor.deleteOrphanInstance(orphan);

    expect(result).toEqual({ containerRemoved: true, runtimeDirectoryRemoved: false });
    expect(await exists(join(outsidePath, "keep.txt"))).toBeTrue();
    expect(warnings).toHaveLength(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("orphan cleanup keeps the instances root when the instance id is empty", async () => {
  const root = await mkdtemp(join(tmpdir(), "endercloud-orphan-"));
  try {
    const instancesRoot = join(root, "instances");
    await mkdir(instancesRoot, { recursive: true });
    await writeFile(join(instancesRoot, "keep.txt"), "keep");
    const orphan = runtime("");
    const { executor } = executorWithDocker(root, orphan);

    const result = await executor.deleteOrphanInstance(orphan);

    expect(result.runtimeDirectoryRemoved).toBeFalse();
    expect(await exists(join(instancesRoot, "keep.txt"))).toBeTrue();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("orphan cleanup refuses deletion when ownership labels changed", async () => {
  const root = await mkdtemp(join(tmpdir(), "endercloud-orphan-"));
  try {
    const orphan = runtime("aB3dE5fG7hJ9kL2m");
    const removeContainer = mock(async () => {});
    const { executor } = executorWithDocker(
      root,
      orphan,
      removeContainer,
      "differentInstance",
    );

    await expect(executor.deleteOrphanInstance(orphan)).rejects.toThrow(
      "ownership labels changed",
    );
    expect(removeContainer).not.toHaveBeenCalled();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
