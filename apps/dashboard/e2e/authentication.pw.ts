import { test, expect } from "@playwright/test";
test.use({ storageState: { cookies: [], origins: [] } });

test("anonymous demo requests require login, and sign out revokes access", async ({
  page,
  request,
}) => {
  expect((await request.get("/api/cluster")).status()).toBe(401);
  await page.goto("/groups");
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel("Email", { exact: true }).fill("browser@example.test");
  await page.getByLabel("Password", { exact: true }).fill("browser-only-password-12345");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL("http://127.0.0.1:3100/");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
  expect((await page.request.get("/api/cluster")).status()).toBe(401);
});
