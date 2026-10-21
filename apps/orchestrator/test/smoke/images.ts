import assert from "node:assert/strict";
import { GenericContainer, Network, Wait, type StartedTestContainer } from "testcontainers";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import Docker from "dockerode";
import { ResourceScope } from "@endercloud/runtime/lifecycle";

// Exercise the production entrypoints and filtered dependency graphs, on disposable data only.
const resources = new ResourceScope();
const containers: StartedTestContainer[] = [];
async function acquire<T>(
  name: string,
  open: () => Promise<T>,
  close: (value: T) => Promise<unknown>,
): Promise<T> {
  const value = await open();
  resources.defer(name, () => close(value));
  return value;
}
async function application(
  name: "orchestrator" | "dashboard" | "web",
  environment: Record<string, string>,
) {
  const port = name === "orchestrator" ? 8080 : 3000;
  const container = await acquire(
    name,
    () =>
      new GenericContainer(`endercloud-${name}:release-test`)
        .withNetwork(network)
        .withNetworkAliases(name)
        .withEnvironment(environment)
        .withExposedPorts(port)
        .withWaitStrategy(
          Wait.forHttp(
            name === "orchestrator" ? "/health/ready" : name === "dashboard" ? "/login" : "/",
            port,
          ),
        )
        .withStartupTimeout(90_000)
        .start(),
    (value) => value.stop(),
  );
  containers.push(container);
  return { container, url: `http://${container.getHost()}:${container.getMappedPort(port)}` };
}
const docker = new Docker({
  socketPath: process.platform === "win32" ? "//./pipe/docker_engine" : "/var/run/docker.sock",
});
const network = await acquire(
  "network",
  () => new Network().start(),
  (value) => value.stop(),
);
try {
  const postgres = await acquire(
    "postgres",
    () =>
      new PostgreSqlContainer("postgres:18.1-alpine")
        .withNetwork(network)
        .withNetworkAliases("postgres")
        .start(),
    (value) => value.stop(),
  );
  await acquire(
    "redis",
    () =>
      new GenericContainer("redis:8.4.0-alpine")
        .withNetwork(network)
        .withNetworkAliases("redis")
        .withExposedPorts(6379)
        .start(),
    (value) => value.stop(),
  );
  const database = new URL(postgres.getConnectionUri());
  database.hostname = "postgres";
  database.port = "5432";
  const origin = "http://127.0.0.1:3000";
  const environment = {
    DATABASE_URL: database.href,
    REDIS_URL: "redis://redis:6379",
    NODE_ENV: "production",
    AUTH_SECRET: "image-tests-only-secret-at-least-32-bytes",
    CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString("base64"),
    DASHBOARD_PUBLIC_URL: origin,
    ORCHESTRATOR_GROUPS_DIRECTORY: "/tmp/groups",
    ORCHESTRATOR_TEMPLATES_DIRECTORY: "/tmp/templates",
    ORCHESTRATOR_LOG_LEVEL: "error",
  };
  const central = await application("orchestrator", environment);
  const admin = await central.container.exec([
    "sh",
    "-c",
    "printf '%s' 'image-test-password-12345' | bun src/security/cli.ts admin:create image@example.test",
  ]);
  assert.equal(admin.exitCode, 0, admin.output);
  const login = await fetch(`${central.url}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ email: "image@example.test", password: "image-test-password-12345" }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  assert.ok(cookie.includes("endercloud"));
  const console = await application("dashboard", {
    ORCHESTRATOR_URL: "http://orchestrator:8080",
    DASHBOARD_PUBLIC_URL: origin,
    DASHBOARD_MOCK_DATA: "false",
  });
  assert.equal((await fetch(console.url, { redirect: "manual" })).status, 307);
  assert.equal((await fetch(`${console.url}/api/cluster`)).status, 401);
  assert.equal((await fetch(`${console.url}/api/cluster`, { headers: { cookie } })).status, 200);
  await docker.getContainer(central.container.getId()).restart();
  const restarted = await docker.getContainer(central.container.getId()).inspect();
  const restartedPort = restarted.NetworkSettings.Ports["8080/tcp"]?.[0]?.HostPort;
  assert.ok(restartedPort, "Restarted control plane has no mapped HTTP port");
  const restartedUrl = new URL(central.url);
  restartedUrl.port = restartedPort;
  const deadline = Date.now() + 30_000;
  while (
    !(
      await fetch(new URL("/health/ready", restartedUrl), {
        signal: AbortSignal.timeout(1_000),
      }).catch(() => null)
    )?.ok
  ) {
    assert.ok(Date.now() < deadline, "Production orchestrator did not reopen its release database");
    await Bun.sleep(250);
  }
  assert.equal((await fetch(`${console.url}/api/cluster`, { headers: { cookie } })).status, 200);
  const web = await application("web", {});
  const guide = await fetch(`${web.url}/docs/configure/authentication`);
  assert.equal(guide.status, 200);
  assert.ok((await guide.text()).includes("Authentication and credentials"));
  const search = await fetch(`${web.url}/api/search?query=credentials`);
  assert.equal(search.status, 200);
  assert.ok(
    JSON.stringify(await search.json())
      .toLowerCase()
      .includes("credentials"),
  );
  for (const frontend of [console, web])
    assert.equal(
      (await docker.getContainer(frontend.container.getId()).inspect()).Config.User,
      "node",
    );
  process.stdout.write(
    "Production image smoke passed: fresh schema, local admin, protected dashboard, persisted session after restart and canonical documentation.\n",
  );
} catch (error) {
  for (const container of containers) {
    const result = Bun.spawnSync(["docker", "logs", "--tail", "60", container.getId()]);
    process.stderr.write(result.stdout);
    process.stderr.write(result.stderr);
  }
  throw error;
} finally {
  await resources.close(60_000);
}
