import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const temporary = resolve(root, ".cache/bun-tmp");
await mkdir(temporary, { recursive: true });
const env = { ...process.env, TEMP: temporary, TMP: temporary, BUN_TMPDIR: temporary };
const onlyTypes = process.argv.includes("--types");
const onlyTests = process.argv.includes("--tests");
const release = process.argv.includes("--release");
const failed: string[] = [];
async function run(name: string, command: string[], directory = root) {
  console.log(`\n[${name}]`);
  const child = Bun.spawn(command, { cwd: directory, env, stdout: "inherit", stderr: "inherit" });
  if (await child.exited !== 0) failed.push(name);
}
if (!onlyTests) {
  await run("boundaries", [process.execPath, "scripts/check-boundaries.ts"]);
  for (const area of ["packages/contracts", "packages/runtime", "apps/orchestrator", "apps/agent", "apps/dashboard", "apps/web"]) await run(`${area}:types`, [process.execPath, "run", "typecheck"], resolve(root, area));
  if (!onlyTypes) for (const app of ["dashboard", "web"]) await run(`${app}:lint`, [process.execPath, "run", "lint"], resolve(root, "apps", app));
}
if (!onlyTypes) {
  for (const app of ["orchestrator", "agent"]) await run(`${app}:unit`, [process.execPath, "run", "test:unit"], resolve(root, "apps", app));
  await run("dashboard:unit", [process.execPath, "test"], resolve(root, "apps/dashboard"));
}
if (release) {
  for (const app of ["dashboard", "web"]) {
    await run(`${app}:build`, [process.execPath, "run", "build"], resolve(root, "apps", app));
    await run(`${app}:browser`, [process.execPath, "run", "test:e2e"], resolve(root, "apps", app));
  }
  await run("orchestrator:integration", [process.execPath, "run", "test:integration"], resolve(root, "apps/orchestrator"));
  await run("installer", ["bash", "test/install.sh"]);
  await run("plugins", [process.platform === "win32" ? "cmd.exe" : "sh", ...(process.platform === "win32" ? ["/c", "gradlew.bat"] : ["./gradlew"]), ":core:build", ":paper:check", ":velocity:check", ":paper:shadowJar", ":velocity:shadowJar"], resolve(root, "plugins"));
}
if (failed.length) { console.error(`\nFailed checks: ${failed.join(", ")}`); process.exitCode = 1; }
else console.log("\nAll requested checks passed.");
