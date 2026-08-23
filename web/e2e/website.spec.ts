import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("landing presents the product without a dashboard action", async ({ page }, testInfo) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  await page.goto("/");
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "Scale from player demand to servers ready",
    }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Read the docs" })).toHaveAttribute("href", "/docs");
  await expect(page.getByRole("link", { name: "View on GitHub" })).toHaveAttribute("href", /github\.com\/nayzflux\/EnderCloud/);
  await expect(page.getByText(/Open dashboard/i)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Expand .* screenshot/i })).toHaveCount(4);

  if (testInfo.project.name === "mobile-chromium") {
    await page.getByRole("button", { name: "Open navigation" }).click();
    await expect(page.getByRole("navigation", { name: "Mobile navigation" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("navigation", { name: "Mobile navigation" })).toBeHidden();
  }

  await page.getByRole("button", { name: "Expand Network topology screenshot" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  expect(consoleErrors).toEqual([]);
});

test("documentation navigation, table of contents, and search work", async ({ page, request }) => {
  await page.goto("/docs");
  await expect(page.getByRole("heading", { level: 1, name: "EnderCloud documentation" })).toBeVisible();
  await page.getByRole("link", { name: /architecture/i }).last().click();
  await expect(page).toHaveURL(/\/docs\/getting-started\/architecture$/);
  await expect(page.getByRole("heading", { level: 2, name: "System view" })).toBeVisible();
  if (test.info().project.name === "desktop-chromium") {
    await expect(page.locator("#nd-toc").getByRole("link", { name: "System view", exact: true })).toBeVisible();
  }

  const response = await request.get("/api/search?query=orchestrator");
  expect(response.ok()).toBeTruthy();
  expect(JSON.stringify(await response.json()).toLowerCase()).toContain("orchestrator");

  await page.getByRole("button", { name: /search/i }).first().click();
  await page.getByRole("textbox").fill("multi-host");
  await expect(page.getByText(/Multi-host deployment/i).first()).toBeVisible();
  await page.keyboard.press("Escape");
});

test("public pages have no serious accessibility violations", async ({ page }) => {
  for (const url of ["/", "/docs", "/docs/configure/groups"]) {
    await page.goto(url);
    await page.waitForTimeout(url === "/" ? 1_100 : 400);
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    const severe = results.violations.filter(
      (violation) => violation.impact === "serious" || violation.impact === "critical",
    );
    expect(severe, `${url}: ${JSON.stringify(severe, null, 2)}`).toEqual([]);
  }
});
