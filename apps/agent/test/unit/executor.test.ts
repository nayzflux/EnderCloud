import { expect, mock, test } from "bun:test";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeInstance } from "@endercloud/contracts/executor";
import {
  decodeDockerLogBuffer,
  instanceName,
  firstAvailablePort,
  LocalDockerExecutor,
  materializeLayers,
  type LocalDockerConfig,
} from "../../src/docker-executor.ts";
import type { Logger } from "@endercloud/runtime/logger";

function config(runtimeRoot: string): LocalDockerConfig {
  return {
    publicUrl: "http://orchestrator:8080",
    dockerSocket: "/var/run/docker.sock",
    dockerNetwork: "endercloud",
    runtimeRoot,
    runtimeHostRoot: runtimeRoot,
    hostId: "test-host",
    gameAddress: "10.0.0.10",
    portStart: 25565,
    portEnd: 25570,
  };
}

function runtime(instanceId: string, containerId = "target-container"): RuntimeInstance {
  return {
    hostId: "test-host",
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
          "orchestrator.host-id": "test-host",
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

test("proxy execution uses its dedicated ports, advertised address and container data directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "endercloud-proxy-executor-"));
  const spec = {
    hostId: "test-host", instanceId: "proxyinstance001", groupId: "edge-proxies", variantId: "velocity-main",
    instanceType: "proxy" as const, templateLayers: [], environment: {},
    runtime: { image: "itzg/mc-proxy:java25", cpu: 1, memoryBytes: 1024 ** 3, environment: {}, dataDirectory: "/server" },
  };
  const executor = new LocalDockerExecutor({
    ...config(root), proxy: { address: "edge.example", portStart: 25700, portEnd: 25702 },
  }, { debug: () => {}, info: () => {} } as unknown as Logger);
  let existing: unknown[] = [];
  const createContainer = mock(async () => ({ id: "proxy-container", start: async () => {} }));
  const docker = {
    listContainers: async (options: { filters?: unknown }) => options.filters ? existing : [
      { Ports: [{ PublicPort: 25700 }], Labels: {} },
      { Ports: [], Labels: { "orchestrator.host-port": "25702" } },
    ],
    getImage: () => ({ inspect: async () => ({}) }),
    createContainer,
  };
  Object.defineProperty(executor, "docker", { value: docker });
  try {
    expect(await executor.createInstance(spec)).toMatchObject({ endpoint: "edge.example:25701" });
    expect(createContainer).toHaveBeenCalledWith(expect.objectContaining({
      Labels: expect.objectContaining({ "orchestrator.instance-type": "proxy" }),
      HostConfig: expect.objectContaining({
        Binds: [join(root, "instances", spec.instanceId) + ":/server"],
        PortBindings: { "25565/tcp": [{ HostIp: "0.0.0.0", HostPort: "25701" }] },
      }),
    }));
    existing = [{ Id: "proxy-container", State: "running", Labels: { "orchestrator.host-port": "25701" } }];
    expect(await executor.createInstance(spec)).toMatchObject({ containerId: "proxy-container", endpoint: "edge.example:25701" });
    expect(createContainer).toHaveBeenCalledTimes(1);
    existing = [];
    const fullRange = new LocalDockerExecutor({
      ...config(root), proxy: { address: "edge.example", portStart: 25700, portEnd: 25700 },
    }, { debug: () => {}, info: () => {} } as unknown as Logger);
    Object.defineProperty(fullRange, "docker", { value: docker });
    await expect(fullRange.createInstance({ ...spec, instanceId: "proxyinstance002" }))
      .rejects.toThrow("No proxy port is available");
    const paperOnly = new LocalDockerExecutor(config(root), {} as Logger);
    await expect(paperOnly.createInstance(spec)).rejects.toThrow("does not support proxy");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("game ports use the first free value in the configured range", () => {
  expect(firstAvailablePort(25565, 25568, new Set([25565, 25566]))).toBe(25567);
  expect(firstAvailablePort(25565, 25566, new Set([25565, 25566]))).toBeNull();
});

test("Docker log frames are demultiplexed before diagnostics are retained", () => {
  const frame = (stream: number, value: string) => {
    const content = Buffer.from(value);
    const header = Buffer.alloc(8);
    header[0] = stream;
    header.writeUInt32BE(content.length, 4);
    return Buffer.concat([header, content]);
  };
  const multiplexed = Buffer.concat([
    frame(1, "server output\n"),
    frame(2, "server error\n"),
  ]);
  expect(decodeDockerLogBuffer(multiplexed).toString("utf8"))
    .toBe("server output\nserver error\n");
  expect(decodeDockerLogBuffer(Buffer.from("plain tty output"))).toEqual(Buffer.from("plain tty output"));
});

test("ordered layers merge recursively and omit control descriptors", async () => {
  const root = await mkdtemp(join(tmpdir(), "endercloud-materialize-"));
  try {
    const base = join(root, "base");
    const final = join(root, "final");
    const runtime = join(root, "runtime");
    await mkdir(join(base, "plugins"), { recursive: true });
    await mkdir(join(base, "config"), { recursive: true });
    await mkdir(join(final, "config"), { recursive: true });
    await mkdir(join(final, "world"), { recursive: true });
    await mkdir(runtime);
    await writeFile(join(base, "variant.yml"), "id: base");
    await writeFile(join(base, "plugins", "shared.jar"), "plugin");
    await writeFile(join(base, "config", "game.yml"), "mode: base");
    await writeFile(join(final, "variant.yml"), "id: final");
    await writeFile(join(final, "config", "game.yml"), "mode: final");
    await writeFile(join(final, "world", "level.dat"), "world");

    await materializeLayers(
      [
        { id: "base", checksum: "base-checksum", templatePath: base },
        { id: "final", checksum: "final-checksum", templatePath: final },
      ],
      runtime,
    );

    expect(await readFile(join(runtime, "config", "game.yml"), "utf8")).toBe("mode: final");
    expect(await readFile(join(runtime, "plugins", "shared.jar"), "utf8")).toBe("plugin");
    expect(await readFile(join(runtime, "world", "level.dat"), "utf8")).toBe("world");
    expect(await exists(join(runtime, "variant.yml"))).toBeFalse();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
