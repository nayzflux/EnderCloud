import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { POST } from "../src/app/api/groups/[groupId]/variants/[variantId]/revisions/[revision]/startup-retry/route";

describe("dashboard startup retry route", () => {
  const original = process.env.DASHBOARD_MOCK_DATA;

  beforeAll(() => {
    process.env.DASHBOARD_MOCK_DATA = "true";
  });

  afterAll(() => {
    if (original === undefined) delete process.env.DASHBOARD_MOCK_DATA;
    else process.env.DASHBOARD_MOCK_DATA = original;
  });

  test("returns the asynchronous resetting state in mock mode", async () => {
    const response = await POST(new Request("http://dashboard"), {
      params: Promise.resolve({
        groupId: "skywars-solo",
        variantId: "skywars-nordic",
        revision: "3",
      }),
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ state: "RESETTING", failureCount: 6 });
  });

  test("rejects invalid path identifiers before proxying", async () => {
    const response = await POST(new Request("http://dashboard"), {
      params: Promise.resolve({ groupId: "invalid!", variantId: "variant", revision: "0" }),
    });
    expect(response.status).toBe(400);
  });
});
