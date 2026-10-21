import { cp, mkdir, stat } from "node:fs/promises";
import { resolve, join } from "node:path";
const app = process.argv[2];
if (app !== "dashboard" && app !== "web") throw new Error("Expected dashboard or web");
const root = resolve(import.meta.dirname, "..");
const directory = resolve(root, "apps", app);
const standalone = join(directory, ".next/standalone/apps", app);
await stat(join(standalone, "server.js")).catch(() => { throw new Error("Run the application build before start"); });
await mkdir(join(standalone, ".next"), { recursive: true });
await cp(join(directory, ".next/static"), join(standalone, ".next/static"), { recursive: true });
if (await stat(join(directory, "public")).then(value => value.isDirectory(), () => false)) await cp(join(directory, "public"), join(standalone, "public"), { recursive: true });
const env = { ...process.env, HOSTNAME: "127.0.0.1", PORT: process.env.PORT ?? "3000" };
for (let index = 3; index < process.argv.length; index += 2) {
  const flag = process.argv[index]; const value = process.argv[index + 1];
  if (!value || !["--hostname", "--port"].includes(flag ?? "")) throw new Error("Supported options: --hostname and --port");
  if (flag === "--hostname") env.HOSTNAME = value; else env.PORT = value;
}
const child = Bun.spawn(["node", join(standalone, "server.js")], { cwd: standalone, env, stdout: "inherit", stderr: "inherit" });
process.once("SIGINT", () => child.kill("SIGINT"));
process.once("SIGTERM", () => child.kill("SIGTERM"));
process.exitCode = await child.exited;
