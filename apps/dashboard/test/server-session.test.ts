import { expect, test } from "bun:test";
import { withDashboardSession } from "../src/lib/server-session";
import { proxyOrchestrator } from "../src/lib/orchestrator-proxy";

test("data routes reject anonymous requests even when demo data is enabled", async () => {
  const route = withDashboardSession(() => Response.json({ secret: "demo" }));
  expect((await route(new Request("http://dashboard/api/cluster"))).status).toBe(401);
});
test("proxy preserves no-content responses, cookies and request identifiers", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response(null, { status: 204, headers: { "x-request-id": "trace-id", "set-cookie": "test=value; HttpOnly" } })) as unknown as typeof fetch;
    const response = await proxyOrchestrator("/api/auth/sign-out", { method: "POST" });
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(response.headers.get("x-request-id")).toBe("trace-id");
    expect(response.headers.getSetCookie()).toEqual(["test=value; HttpOnly"]);
  } finally { globalThis.fetch = original; }
});
