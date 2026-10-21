import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import Docker from "dockerode";
import { GenericContainer, Network, Wait, type StartedTestContainer } from "testcontainers";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { loadConfig } from "../../src/config.ts";
import { startOrchestrator } from "../../src/bootstrap.ts";
import { createDatabase } from "../../src/db/client.ts";
import { migrateDatabase } from "../../src/db/migrate.ts";
import { commands, serverInstances } from "../../src/db/schema.ts";
import { createAuth } from "../../src/security/auth.ts";
import { createAdministrator } from "../../src/security/cli.ts";
import { Credentials } from "../../src/security/credentials.ts";
import { ResourceScope } from "@endercloud/runtime/lifecycle";

// Every resource is created by this run. Existing deployments and databases are never touched.
const root = resolve(import.meta.dirname, "../../../..");
await mkdir(join(root, ".cache"), { recursive: true });
const directory = await mkdtemp(join(root, ".cache/two-agents-"));
const resources = new ResourceScope();
resources.defer("scratch directory", () => rm(directory, { recursive: true, force: true }));
async function acquire<T>(
  name: string,
  open: () => Promise<T>,
  close: (value: T) => Promise<unknown>,
): Promise<T> {
  try {
    const value = await open();
    resources.defer(name, () => close(value));
    return value;
  } catch (error) {
    await resources.close();
    throw error;
  }
}
const runId = `ec-smoke-${Date.now()}`;
const docker = new Docker({
  socketPath: process.platform === "win32" ? "//./pipe/docker_engine" : "/var/run/docker.sock",
});
const postgres = await acquire(
  "postgres",
  () => new PostgreSqlContainer("postgres:18.1-alpine").start(),
  (value) => value.stop(),
);
const redis = await acquire(
  "redis",
  () => new GenericContainer("redis:8.4.0-alpine").withExposedPorts(6379).start(),
  (value) => value.stop(),
);
const network = await acquire(
  "network",
  () => new Network().start(),
  (value) => value.stop(),
);
const database = createDatabase(postgres.getConnectionUri());
resources.defer("database", () => database.sql.end());
const agents: StartedTestContainer[] = [];
const volumes: Docker.Volume[] = [];
let orchestrator: Awaited<ReturnType<typeof startOrchestrator>> | undefined;
const image = `endercloud-smoke-runtime:${runId}`;
let imageCreated = false;
const timeout = AbortSignal.timeout(180_000);
function freePort() {
  const server = Bun.serve({ port: 0, hostname: "0.0.0.0", fetch: () => new Response() });
  const port = server.port!;
  server.stop(true);
  return port;
}
async function until(label: string, check: () => Promise<boolean>) {
  while (!(await check())) {
    timeout.throwIfAborted();
    await Bun.sleep(250);
  }
  console.log(`Validated: ${label}`);
}
async function request(base: string, path: string, token?: string, init: RequestInit = {}) {
  const response = await fetch(new URL(path, base), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    signal: AbortSignal.timeout(10_000),
  });
  return response;
}
try {
  await docker
    .getImage(process.env.TEST_AGENT_IMAGE ?? "endercloud-agent:release-test")
    .inspect()
    .catch(() => {
      throw new Error(
        "Build the agent image first: docker build -f apps/agent/Dockerfile -t endercloud-agent:release-test .",
      );
    });
  try {
    await docker.getImage("alpine:3.22.1").inspect();
  } catch {
    const stream = await docker.pull("alpine:3.22.1");
    await new Promise<void>((resolvePull, reject) =>
      docker.modem.followProgress(stream, (error) => (error ? reject(error) : resolvePull())),
    );
  }
  const builder = await docker.createContainer({ Image: "alpine:3.22.1", Cmd: ["sleep", "3600"] });
  try {
    await builder.commit({ repo: "endercloud-smoke-runtime", tag: runId });
    imageCreated = true;
  } finally {
    await builder.remove();
  }
  await mkdir(join(directory, "groups"));
  await mkdir(join(directory, "templates/smoke-layer"), { recursive: true });
  const group = (enabled: boolean) =>
    `id: smoke-hubs\ntype: hub\nenabled: ${enabled}\nvariants:\n  - id: smoke-layer\n    weight: 1\ncapacity:\n  minimum_instances: 2\n  maximum_instances: 2\n  minimum_warm_instances: 2\n  maximum_warm_instances: 2\nrouting:\n  maximum_players_per_instance: 10\n  target_players_per_instance: 8\ntimeouts:\n  startup: 2m\n  drain: 1s\n  cancelled_drain: 1s\n  shutdown: 1s\n  transfer: 10s\n  player_stale: 30s\n`;
  const groupFile = join(directory, "groups/hubs.yml");
  await writeFile(groupFile, group(true));
  await writeFile(
    join(directory, "templates/smoke-layer/variant.yml"),
    `id: smoke-layer\nrevision: 1\ndocker:\n  image: ${image}\n  memory: 64M\n  cpu: 1\n`,
  );
  await writeFile(join(directory, "templates/smoke-layer/smoke.txt"), "downloaded and verified\n");
  await migrateDatabase(postgres.getConnectionUri());
  const security = {
    secret: "smoke-only-auth-secret-at-least-32-bytes",
    encryptionKey: Buffer.alloc(32, 3),
    origin: "http://localhost:3000",
  };
  await createAdministrator(
    database.db,
    security,
    "smoke@example.test",
    "smoke-only-password-12345",
  );
  const credentials = new Credentials(database.db, createAuth(database.db, security), security);
  const config = {
    ...loadConfig({
      DATABASE_URL: postgres.getConnectionUri(),
      REDIS_URL: `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`,
      ORCHESTRATOR_GROUPS_DIRECTORY: join(directory, "groups"),
      ORCHESTRATOR_TEMPLATES_DIRECTORY: join(directory, "templates"),
      ORCHESTRATOR_LOG_LEVEL: "error",
      SCHEDULER_CAPACITY_INTERVAL: "1s",
      SCHEDULER_RECONCILIATION_INTERVAL: "1s",
    }),
    port: freePort(),
    paperHealthLeaseMs: 300_000,
  };
  orchestrator = await startOrchestrator(config, security);
  const base = `http://127.0.0.1:${config.port}`;
  const secrets = new Map<string, { apiToken: string; controlToken?: string }>();
  for (let index = 0; index < 2; index++) {
    const id = `${runId}-${index}`;
    const secret = await credentials.ensure("agent", id);
    secrets.set(id, secret);
    const volumeName = `${runId}-${index}`;
    await docker.createVolume({ Name: volumeName });
    const volume = docker.getVolume(volumeName);
    volumes.push(volume);
    const mount = (await volume.inspect()).Mountpoint;
    const controlPort = freePort();
    const gamePort = freePort();
    let container = new GenericContainer(
      process.env.TEST_AGENT_IMAGE ?? "endercloud-agent:release-test",
    )
      .withNetwork(network)
      .withExposedPorts({ container: 8090, host: controlPort })
      .withBindMounts([
        { source: mount, target: "/data/runtime" },
        { source: "/var/run/docker.sock", target: "/var/run/docker.sock" },
      ])
      .withEnvironment({
        AGENT_ID: id,
        AGENT_LISTEN_PORT: "8090",
        AGENT_ADVERTISED_CONTROL_URL: `http://127.0.0.1:${controlPort}`,
        AGENT_ADVERTISED_GAME_ADDRESS: "127.0.0.1",
        AGENT_ALLOCATABLE_CPU: "1",
        AGENT_ALLOCATABLE_MEMORY_BYTES: String(128 * 1024 ** 2),
        AGENT_GAME_PORT_START: String(gamePort),
        AGENT_GAME_PORT_END: String(gamePort),
        AGENT_HEARTBEAT_INTERVAL: "1s",
        AGENT_DOCKER_NETWORK: network.getName(),
        AGENT_RUNTIME_DIRECTORY: "/data/runtime",
        AGENT_RUNTIME_HOST_DIRECTORY: mount,
        AGENT_TEMPLATE_CACHE_DIRECTORY: "/data/template-cache",
        AGENT_ORCHESTRATOR_TOKEN: secret.apiToken,
        AGENT_CONTROL_TOKEN: secret.controlToken!,
        ORCHESTRATOR_URL: `http://host.docker.internal:${config.port}`,
        AGENT_LOG_LEVEL: "error",
      })
      .withWaitStrategy(Wait.forHttp("/health/ready", 8090))
      .withStartupTimeout(60_000);
    if (process.platform !== "win32")
      container = container.withExtraHosts([
        { host: "host.docker.internal", ipAddress: "host-gateway" },
      ]);
    agents.push(await container.start());
  }
  await until("two real agents materialize one runtime each", async () => {
    const rows = await database.db.select().from(serverInstances);
    return (
      rows.length === 2 &&
      rows.every((row) => row.lifecycleState === "STARTING") &&
      new Set(rows.map((row) => row.hostId)).size === 2
    );
  });
  const rows = await database.db.select().from(serverInstances);
  for (const row of rows) {
    const token = (await credentials.get("paper", row.id))!.apiToken;
    assert.equal(
      (
        await request(base, `/api/v1/instances/${row.id}/events`, token, {
          method: "POST",
          body: JSON.stringify({ type: "SERVER_READY" }),
        })
      ).status,
      202,
    );
  }
  const first = rows[0]!;
  const firstHost = first.hostId!;
  const firstAgent = agents[Number(firstHost.at(-1))]!;
  const control = `http://${firstAgent.getHost()}:${firstAgent.getMappedPort(8090)}`;
  assert.equal((await request(control, "/api/v1/instances")).status, 401);
  assert.equal(
    (
      await request(base, "/api/v1/hosts/other-host/heartbeat", secrets.get(firstHost)!.apiToken, {
        method: "PUT",
        body: "{}",
      })
    ).status,
    403,
  );
  const [command] = await database.db
    .select()
    .from(commands)
    .where(eq(commands.instanceId, first.id));
  const payload = command!.payload as {
    instanceType: "paper";
    runtime: object;
    templateLayers: object[];
  };
  const staleCreate = {
    ...payload,
    hostId: firstHost,
    instanceId: first.id,
    groupId: first.groupId,
    variantId: first.variantId,
    environment: { ENDERCLOUD_API_TOKEN: (await credentials.get("paper", first.id))!.apiToken },
  };
  await orchestrator.shutdown();
  orchestrator = undefined;
  assert.equal(
    (
      await request(
        control,
        `/api/v1/instances/${first.id}`,
        secrets.get(firstHost)!.controlToken,
        { method: "DELETE" },
      )
    ).status,
    204,
  );
  await docker.getContainer(firstAgent.getId()).restart();
  await until(
    "agent restarts with its SQLite journal",
    async () => (await request(control, "/health/ready").catch(() => null))?.ok ?? false,
  );
  assert.equal(
    (
      await request(
        control,
        `/api/v1/instances/${first.id}`,
        secrets.get(firstHost)!.controlToken,
        { method: "PUT", body: JSON.stringify(staleCreate) },
      )
    ).status,
    409,
  );
  await writeFile(groupFile, group(false));
  orchestrator = await startOrchestrator(config, security);
  await until(
    "restart reconciles persisted release state and confirms physical deletion",
    async () =>
      (await database.db.select().from(serverInstances)).every(
        (row) => row.lifecycleState === "STOPPED",
      ),
  );
  console.log(
    "Two-agent authenticated Docker smoke test passed, including restart and stale CREATE rejection.",
  );
} finally {
  try {
    await orchestrator?.shutdown().catch(() => {});
    for (const agent of agents) await agent.stop().catch(() => {});
    const runtimes = await docker.listContainers({
      all: true,
      filters: { network: [network.getId()], label: [`orchestrator.host-id=${runId}-0`] },
    });
    const other = await docker.listContainers({
      all: true,
      filters: { network: [network.getId()], label: [`orchestrator.host-id=${runId}-1`] },
    });
    for (const runtime of [...runtimes, ...other])
      await docker
        .getContainer(runtime.Id)
        .remove({ force: true })
        .catch(() => {});
    for (const volume of volumes) await volume.remove().catch(() => {});
    if (imageCreated)
      await docker
        .getImage(image)
        .remove({ force: true })
        .catch(() => {});
  } finally {
    await resources.close(60_000);
  }
}
