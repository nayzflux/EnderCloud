import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const temporary = resolve(root, ".cache/bun-tmp");
await mkdir(temporary, { recursive: true });
const env: Record<string, string | undefined> = {
  ...process.env,
  TEMP: temporary,
  TMP: temporary,
  BUN_TMPDIR: temporary,
};
const onlyTypes = process.argv.includes("--types");
const onlyTests = process.argv.includes("--tests");
const release = process.argv.includes("--release");
const failed: string[] = [];

async function run(name: string, command: string[], directory = root): Promise<boolean> {
  console.log(`\n[${name}]`);
  try {
    const child = Bun.spawn(command, { cwd: directory, env, stdout: "inherit", stderr: "inherit" });
    if ((await child.exited) === 0) return true;
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
  }
  failed.push(name);
  return false;
}
const bun = process.execPath;
if (!onlyTests) {
  await run("tooling:types", [
    bun,
    "x",
    "--no-install",
    "tsc",
    "--project",
    "scripts/tsconfig.json",
  ]);
  await run("boundaries", [bun, "scripts/check-boundaries.ts"]);
  await run("documentation", [bun, "scripts/check-docs.ts"]);
  for (const area of [
    "packages/contracts",
    "packages/runtime",
    "apps/orchestrator",
    "apps/agent",
    "apps/dashboard",
    "apps/web",
  ])
    await run(`${area}:types`, [bun, "run", "typecheck"], resolve(root, area));
  if (!onlyTypes) {
    await run("format", [bun, "run", "format:check"]);
    for (const app of ["dashboard", "web"])
      await run(`${app}:lint`, [bun, "run", "lint"], resolve(root, "apps", app));
  }
}
if (!onlyTypes) {
  for (const app of ["orchestrator", "agent"])
    await run(`${app}:unit`, [bun, "run", "test:unit"], resolve(root, "apps", app));
  await run("dashboard:unit", [bun, "test"], resolve(root, "apps/dashboard"));
}
if (release) {
  await run("compose", [bun, "scripts/check-compose.ts"]);
  await run(
    "orchestrator:integration",
    [bun, "run", "test:integration"],
    resolve(root, "apps/orchestrator"),
  );
  if (process.platform === "win32") {
    await run("installer", [
      "docker",
      "run",
      "--rm",
      "-e",
      "REAL_DOCKER=/usr/local/bin/docker",
      "--mount",
      `type=bind,source=${root},target=/workspace,readonly`,
      "-w",
      "/workspace",
      "docker:29-cli",
      "sh",
      "-c",
      "apk add --no-cache bash coreutils >/dev/null && bash -n install.sh && bash test/install.sh",
    ]);
  } else {
    env.REAL_DOCKER ??= Bun.which("docker") ?? undefined;
    await run("installer", ["bash", "test/install.sh"]);
  }
  let dockerJava = !Bun.which("java");
  if (!dockerJava) {
    const version = Bun.spawnSync(["java", "-version"]);
    dockerJava = !/version "25[."]/.test(version.stderr.toString() + version.stdout.toString());
  }
  if (dockerJava) {
    const gradleCache = resolve(root, ".cache/gradle");
    await mkdir(gradleCache, { recursive: true });
    await run("plugins", [
      "docker",
      "run",
      "--rm",
      "--mount",
      `type=bind,source=${resolve(root, "plugins")},target=/workspace`,
      "--mount",
      `type=bind,source=${resolve(root, "contracts")},target=/contracts,readonly`,
      "--mount",
      `type=bind,source=${gradleCache},target=/root/.gradle`,
      "-w",
      "/workspace",
      "eclipse-temurin:25-jdk",
      "java",
      "-classpath",
      "gradle/wrapper/gradle-wrapper.jar",
      "org.gradle.wrapper.GradleWrapperMain",
      "--no-daemon",
      "--dependency-verification=strict",
      "build",
    ]);
  } else {
    await run(
      "plugins",
      process.platform === "win32"
        ? [
            "cmd.exe",
            "/c",
            "gradlew.bat",
            "--no-daemon",
            "--dependency-verification=strict",
            "build",
          ]
        : ["sh", "./gradlew", "--no-daemon", "--dependency-verification=strict", "build"],
      resolve(root, "plugins"),
    );
  }
  let agentBuilt = false;
  let allImagesBuilt = true;
  for (const app of ["agent", "orchestrator", "dashboard", "web"]) {
    const built = await run(`${app}:image`, [
      "docker",
      "build",
      "-f",
      `apps/${app}/Dockerfile`,
      "-t",
      `endercloud-${app}:release-test`,
      ".",
    ]);
    if (app === "agent") agentBuilt = built;
    allImagesBuilt &&= built;
  }
  if (allImagesBuilt) await run("production-images", [bun, "run", "test:images"]);
  else failed.push("production-images:missing-current-image");
  if (agentBuilt) await run("two-agents", [bun, "run", "test:two-agents"]);
  else failed.push("two-agents:missing-current-agent-image");
  for (const app of ["dashboard", "web"])
    await run(`${app}:browser`, [bun, "run", "test:e2e"], resolve(root, "apps", app));
}
if (failed.length) {
  console.error(`\nFailed checks: ${failed.join(", ")}`);
  process.exitCode = 1;
} else console.log("\nAll requested checks passed.");
