import { proxyOrchestrator } from "@/lib/orchestrator-proxy";
import { dashboardRequest } from "@/lib/server-session";

export const dynamic = "force-dynamic";
const allowed = new Map([["/api/auth/get-session", "GET"], ["/api/auth/sign-in/email", "POST"], ["/api/auth/sign-out", "POST"]]);
async function handle(request: Request) {
  const path = new URL(request.url).pathname;
  if (allowed.get(path) !== request.method) return new Response(null, { status: 404 });
  const body = request.method === "POST" ? await request.text() : undefined;
  if (body && Buffer.byteLength(body) > 16_384) return new Response(null, { status: 413 });
  return dashboardRequest.run(request, () => proxyOrchestrator(path, { method: request.method, ...(body ? { body } : {}) }));
}
export const GET = handle;
export const POST = handle;
