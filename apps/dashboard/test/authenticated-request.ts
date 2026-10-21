const originalFetch = globalThis.fetch;
export function installAuthenticatedFetch() {
  globalThis.fetch = (async () => Response.json({ user: { id: "test-admin" }, session: { id: "test-session" } })) as unknown as typeof fetch;
}
export function restoreFetch() { globalThis.fetch = originalFetch; }
export function authenticatedRequest(url: string) {
  return new Request(url, { method: url === "http://dashboard" ? "POST" : "GET", headers: { cookie: "test-session", origin: "http://dashboard" } });
}
