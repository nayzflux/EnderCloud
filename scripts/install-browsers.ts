import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
const child = Bun.spawn(
  [process.execPath, "x", "--no-install", "playwright", "install", "chromium", "--only-shell"],
  {
    cwd: resolve(root, "apps/dashboard"),
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: resolve(root, ".cache/playwright") },
  },
);
process.exitCode = await child.exited;
