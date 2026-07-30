import { expect, test, type Page } from "@playwright/test";

/**
 * The suite runs against the synthetic cluster served when DASHBOARD_MOCK_DATA
 * is enabled (see playwright.config.ts), so it exercises the real proxy routes
 * without an orchestrator behind them.
 */

const desktopOnly = (page: Page) => page.viewportSize()!.width >= 768;

/** Table rows are `tr[role=button]`; some cells hold their own buttons. */
const tableRows = (page: Page) =>
  page.getByRole("button").filter({ has: page.locator("td") });

/** Clicks a row on its first cell, away from any nested control. */
async function openRow(page: Page, index = 0) {
  const row = tableRows(page).nth(index);
  await expect(row).toBeVisible();
  await row.locator("td").first().click();
}

/**
 * Pages render their header straight away and their data once the shared
 * cluster snapshot lands, so each test waits on the content it actually needs.
 */
async function visit(page: Page, path: string) {
  // `load` guarantees the client bundle is in, so clicks land on a hydrated
  // tree rather than on the server-rendered markup.
  await page.goto(path, { waitUntil: "load" });
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
}

/** The canvas is a lazily imported client chunk; give it room to arrive. */
async function visitTopology(page: Page) {
  await visit(page, "/topology");
  await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".react-flow__node-groupFrame").first()).toBeVisible({
    timeout: 20_000,
  });
}

test.describe("overview", () => {
  test("summarises the fleet", async ({ page }) => {
    await visit(page, "/");
    await expect(
      page.getByRole("heading", { name: "Cluster overview" }),
    ).toBeVisible();

    await expect(page.getByText("Fleet health", { exact: true })).toBeVisible();
    await expect(page.getByText("Needs attention", { exact: true })).toBeVisible();
    // The groups table, not the sidebar entry of the same name.
    await expect(
      page.getByText("Capacity, occupancy and queue pressure", { exact: false }),
    ).toBeVisible();

    // Synthetic groups from the mock cluster.
    await expect(page.getByText("skywars-solo").first()).toBeVisible();
    await expect(page.getByText("bedwars-duo").first()).toBeVisible();
  });

  test("reports live synchronisation in the header", async ({ page }) => {
    await visit(page, "/");
    await expect(page.getByText(/^(Live|Syncing)$/)).toBeVisible();
  });
});

test.describe("instances", () => {
  test("lists instances and opens the detail panel", async ({ page }) => {
    await visit(page, "/instances");
    await expect(page.getByRole("heading", { name: "Instances" })).toBeVisible();

    await openRow(page);
    const panel = page.getByRole("dialog");
    await expect(panel.getByRole("tab", { name: /Overview/ })).toBeVisible();
    await expect(panel.getByText("Runtime", { exact: true })).toBeVisible();

    await panel.getByRole("tab", { name: /Events/ }).click();
    await expect(panel.getByText(/instance\./).first()).toBeVisible();
  });

  test("shows the lifecycle as an ordered timeline", async ({ page }) => {
    await visit(page, "/instances");
    await openRow(page);

    const panel = page.getByRole("dialog");
    await expect(panel.getByText("Lifecycle", { exact: true })).toBeVisible();

    const steps = panel.locator("ol li");
    await expect(steps.filter({ hasText: "Created" })).toBeVisible();
    await expect(steps.filter({ hasText: "Container starting" })).toBeVisible();
    await expect(steps.filter({ hasText: "Ready" })).toBeVisible();
    // Steps not reached yet are called out rather than shown as an em dash.
    await expect(panel.getByText("pending").first()).toBeVisible();
  });

  test("keeps elapsed times ticking between packets", async ({ page }) => {
    await visit(page, "/instances");

    const age = page.locator("tbody tr").first().locator("time").last();
    await expect(age).toBeVisible();
    const first = await age.textContent();

    // Well under the five-second refetch: any change comes from the local clock.
    await page.waitForTimeout(2_200);
    await expect
      .poll(async () => age.textContent())
      .not.toBe(first);
  });

  test("keeps the timeline live while refresh is paused", async ({ page }) => {
    test.skip(!desktopOnly(page), "the refresh interval control is desktop-only");
    let clusterRequests = 0;
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/cluster") clusterRequests += 1;
    });
    await visit(page, "/instances");

    await page.getByLabel("Auto-refresh interval").click();
    await page.getByRole("option", { name: "Paused" }).click();

    const startingRow = tableRows(page).filter({ hasText: "Starting" }).first();
    await expect(startingRow).toBeVisible();
    const age = startingRow.locator("time").last();
    const firstAge = await age.textContent();
    const requestsAtPause = clusterRequests;

    // Longer than the default refresh interval: only the client clock moves.
    await page.waitForTimeout(5_500);
    await expect.poll(async () => age.textContent()).not.toBe(firstAge);
    expect(clusterRequests).toBe(requestsAtPause);

    await startingRow.locator("td").first().click();
    const panel = page.getByRole("dialog");
    await expect(panel.getByText("Startup deadline", { exact: true })).toBeVisible();
    await expect(panel.getByText(/overdue by/)).toBeVisible();
  });

  test("narrows the table down to degraded instances", async ({ page }) => {
    test.skip(!desktopOnly(page), "state filter is shown on wide viewports too");
    await visit(page, "/instances");

    await expect(page.locator("tbody tr").first()).toBeVisible();
    const before = await page.locator("tbody tr").count();

    await page.getByLabel("Filter by state").click();
    const option = page.getByRole("option", { name: "Needs attention" });
    await expect(option).toBeVisible();
    await option.click();

    await expect
      .poll(async () => page.locator("tbody tr").count())
      .toBeLessThan(before);
    await expect(page.getByText("Failed").first()).toBeVisible();
  });
});

test.describe("sessions", () => {
  test("separates session occupancy from transferred players", async ({ page }) => {
    await visit(page, "/sessions");
    await expect(page.getByRole("heading", { name: "Sessions" })).toBeVisible();
    await expect(
      page.getByRole("columnheader", { name: "Session players" }),
    ).toBeVisible();
    await expect(
      page.getByRole("columnheader", { name: "Transferred" }),
    ).toBeVisible();

    await openRow(page);

    const panel = page.getByRole("dialog");
    await expect(panel.getByText("In session", { exact: true })).toBeVisible();
    await expect(panel.getByText("Transferred", { exact: true })).toBeVisible();
    await expect(
      panel.getByText("Active players / session capacity", { exact: true }),
    ).toBeVisible();
    await expect(
      panel.getByText("Connected to server / active players", { exact: true }),
    ).toBeVisible();
  });
});

test.describe("queues", () => {
  test("shows queue pressure per matchmaking group", async ({ page }) => {
    await visit(page, "/queues");
    await expect(
      page.getByRole("heading", { name: "Matchmaking queues" }),
    ).toBeVisible();

    await expect(page.getByText("PARTIES QUEUED").first()).toBeVisible();
    await expect(page.getByText("LONGEST WAIT").first()).toBeVisible();

    // One tab per matchmaking group, hub excluded.
    await expect(page.getByRole("tab", { name: /skywars-solo/ })).toBeVisible();
    await expect(page.getByRole("tab", { name: /bedwars-duo/ })).toBeVisible();
    await expect(page.getByRole("tab", { name: /^hub/ })).toHaveCount(0);

    await expect(
      page.getByText("Wait distribution", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Queued parties", { exact: true })).toBeVisible();
    await expect(page.locator("tbody tr").first()).toBeVisible();
  });

  test("switches between groups", async ({ page }) => {
    await visit(page, "/queues");
    await page.getByRole("tab", { name: /bedwars-duo/ }).click();
    await expect(page.getByRole("tab", { name: /bedwars-duo/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page.getByText("PARTIES WAITING").first()).toBeVisible();
  });
});

test.describe("topology", () => {
  test("draws the group frames, instances and their edges", async ({ page }) => {
    await visitTopology(page);
    await expect(page.getByRole("heading", { name: "Topology" })).toBeVisible();
    await expect
      .poll(async () => page.locator(".react-flow__node-instance").count())
      .toBeGreaterThan(0);
    await expect
      .poll(async () => page.locator(".react-flow__edge").count())
      .toBeGreaterThan(0);
    // The minimap needs the nodes to carry their own dimensions.
    await expect
      .poll(async () => page.locator(".react-flow__minimap-node").count())
      .toBeGreaterThan(0);
  });

  test("opens the detail panel from an instance node", async ({ page }) => {
    test.skip(!desktopOnly(page), "node targets are too small on a phone");
    await visitTopology(page);
    const node = page.locator(".react-flow__node-instance").first();
    await expect(node).toBeVisible();
    await node.click();
    await expect(
      page.getByRole("dialog").getByText("Instance", { exact: true }),
    ).toBeVisible();
  });
});

test.describe("shell", () => {
  test("navigates through the sidebar", async ({ page }) => {
    test.skip(!desktopOnly(page), "the sidebar is off-canvas on a phone");
    await visit(page, "/");

    for (const [label, href, heading] of [
      ["Groups", "/groups", "Groups"],
      ["Queues", "/queues", "Matchmaking queues"],
      ["Sessions", "/sessions", "Sessions"],
      ["Overview", "/", "Cluster overview"],
    ] as const) {
      await page.getByRole("link", { name: label, exact: true }).click();
      // Navigation is client-side: settle on the route before asserting.
      await page.waitForURL((url) => url.pathname === href);
      await expect(page.getByRole("heading", { name: heading })).toBeVisible();
    }
  });

  test("switches to the dark theme", async ({ page }) => {
    await visit(page, "/");
    await page.getByRole("button", { name: "Change theme" }).click();
    const dark = page.getByRole("menuitem", { name: "Dark" });
    await expect(dark).toBeVisible();
    await dark.click();
    await expect(page.locator("html")).toHaveClass(/dark/);
  });

  test("flags synthetic data mode", async ({ page }) => {
    test.skip(!desktopOnly(page), "the sidebar footer is off-canvas on a phone");
    await visit(page, "/");
    await expect(page.getByText("Synthetic data")).toBeVisible();
  });

  test("stays usable on a narrow viewport", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile");
    await visit(page, "/instances");
    await expect(page.getByRole("heading", { name: "Instances" })).toBeVisible();
    await expect(page.getByLabel("Search instances")).toBeVisible();
    await expect(page.locator("tbody tr").first()).toBeVisible();

    await page.getByRole("button", { name: "Toggle Sidebar" }).click();
    await expect(page.getByRole("link", { name: "Queues", exact: true })).toBeVisible();
  });
});
