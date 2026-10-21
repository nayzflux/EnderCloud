import { mkdir, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
const file = resolve(root, ".cache/compose-validation.env");
await mkdir(resolve(root, ".cache"), { recursive: true });
const environment = {
  POSTGRES_DB: "release_test",
  POSTGRES_USER: "release_test",
  POSTGRES_PASSWORD: "validation_only",
  DATABASE_URL: "postgres://release_test:validation_only@postgres:5432/release_test",
  AUTH_SECRET: "validation-only-secret-at-least-32-bytes",
  CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64"),
  DASHBOARD_PUBLIC_URL: "http://127.0.0.1:3000",
  REDIS_PUBLISHER_PASSWORD: "a".repeat(64),
  REDIS_PROXY_PASSWORD: "b".repeat(64),
  AGENT_ID: "validation-host",
  AGENT_ADVERTISED_GAME_ADDRESS: "192.0.2.10",
  AGENT_ALLOCATABLE_CPU: "4",
  AGENT_ALLOCATABLE_MEMORY_BYTES: "8589934592",
  AGENT_RUNTIME_HOST_DIRECTORY: resolve(root, ".cache/runtime"),
  AGENT_PUBLISH_ADDRESS: "127.0.0.1",
  AGENT_ADVERTISED_CONTROL_URL: "http://127.0.0.1:8090",
  ORCHESTRATOR_URL: "http://127.0.0.1:8080",
  SECONDARY_AGENT_GAME_ADDRESS: "192.0.2.11",
  SECONDARY_RUNTIME_HOST_ROOT: resolve(root, ".cache/runtime-secondary"),
};
await writeFile(
  file,
  Object.entries(environment)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n"),
);
try {
  for (const paths of [
    ["compose.yml"],
    ["compose.agent.yml"],
    ["compose.yml", "compose.multi-host.test.yml"],
  ]) {
    const child = Bun.spawn(
      [
        "docker",
        "compose",
        "--env-file",
        file,
        ...paths.flatMap((path) => ["-f", path]),
        "config",
        "--quiet",
      ],
      { cwd: root, stdout: "inherit", stderr: "inherit" },
    );
    if ((await child.exited) !== 0)
      throw new Error(`Invalid Compose configuration: ${paths.join(", ")}`);
  }
  console.log("Central, worker and multi-host Compose configurations passed.");
} finally {
  await rm(file, { force: true });
}
