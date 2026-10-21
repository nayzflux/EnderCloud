import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";

process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve(import.meta.dirname, "../../.cache/playwright");

const PORT = 3100;
const baseURL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.pw.ts",
  fullyParallel: true,
  workers: 1,
  globalSetup: "./e2e/global-setup.ts",
  retries: process.env.CI ? 1 : 0,
  reporter: "list",
  timeout: 45_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL,
    storageState: resolve(import.meta.dirname, "../../.cache/dashboard-browser-session.json"),
    trace: "retain-on-failure",
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
  },
  webServer: [
    {
      command: "bun ../orchestrator/test/smoke/dashboard-auth.ts",
      url: "http://127.0.0.1:3180/health/live",
      reuseExistingServer: false,
      timeout: 90_000,
    },
    {
      // A production server on its own port: no compile-on-demand stalls under
      // parallel load, and it never collides with a dev server on 3000.
      command: "bun run build && bun run start",
      url: baseURL,
      reuseExistingServer: false,
      timeout: 240_000,
      // Demo topology uses a disposable PostgreSQL-backed authentication service.
      env: {
        DASHBOARD_MOCK_DATA: "true",
        PORT: String(PORT),
        ORCHESTRATOR_URL: "http://127.0.0.1:3180",
        DASHBOARD_PUBLIC_URL: baseURL,
      },
    },
  ],
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "mobile",
      use: { ...devices["iPhone 13"], browserName: "chromium" },
    },
  ],
});
