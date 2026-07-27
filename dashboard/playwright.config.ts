import { defineConfig, devices } from "@playwright/test";

const PORT = 3100;
const baseURL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.pw.ts",
  fullyParallel: true,
  // The console polls the cluster every few seconds, so a click can land on a
  // re-render under parallel load; one retry absorbs that without hiding bugs.
  retries: 1,
  reporter: "list",
  timeout: 45_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL,
    trace: "retain-on-failure",
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
  },
  webServer: {
    // A production server on its own port: no compile-on-demand stalls under
    // parallel load, and it never collides with a dev server on 3000.
    command: "bun run build && bun run start",
    url: baseURL,
    reuseExistingServer: true,
    timeout: 240_000,
    // The suite runs against the synthetic cluster, so it needs neither the
    // orchestrator nor Docker.
    env: { DASHBOARD_MOCK_DATA: "true", PORT: String(PORT) },
  },
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
