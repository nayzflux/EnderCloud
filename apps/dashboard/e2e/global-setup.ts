import { request } from "@playwright/test";
import { resolve } from "node:path";
export default async function setup() {
  const context = await request.newContext({ baseURL: "http://127.0.0.1:3100" });
  try {
    const response = await context.post("/api/auth/sign-in/email", { headers: { origin: "http://127.0.0.1:3100" },
      data: { email: "browser@example.test", password: "browser-only-password-12345" } });
    if (!response.ok()) throw new Error(`Browser test authentication failed (${response.status()})`);
    await context.storageState({ path: resolve("../../.cache/dashboard-browser-session.json") });
  } finally { await context.dispose(); }
}
