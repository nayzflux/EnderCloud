import { expect, test } from "bun:test";
import { readJsonResponse, requestJson } from "@endercloud/contracts/http";
test("HTTP clients accept no-content responses and preserve upstream diagnostics", async () => {
  expect(await readJsonResponse(new Response(null, { status: 204 }))).toBeUndefined();
  await expect(readJsonResponse(Response.json({ message: "Conflict" }, { status: 409, headers: { "x-request-id": "trace" } }))).rejects.toMatchObject({ status: 409, message: "Conflict", requestId: "trace" });
  await expect(readJsonResponse(new Response("invalid"))).rejects.toMatchObject({ status: 502 });
});
test("caller cancellation is propagated to the HTTP transport", async () => {
  const previous = globalThis.fetch;
  const controller = new AbortController(); controller.abort(new Error("cancelled"));
  try {
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => { init?.signal?.throwIfAborted(); return Response.json({}); }) as unknown as typeof fetch;
    await expect(requestJson("http://backend", { signal: controller.signal })).rejects.toThrow("cancelled");
  } finally { globalThis.fetch = previous; }
});
