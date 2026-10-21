import { AsyncLocalStorage } from "node:async_hooks";

export const dashboardRequest = new AsyncLocalStorage<Request>();
export const orchestratorUrl = () => process.env.ORCHESTRATOR_URL ?? "http://localhost:8080";

export async function getDashboardSession(request: Request): Promise<boolean> {
  const cookie = request.headers.get("cookie");
  if (!cookie) return false;
  const response = await fetch(new URL("/api/auth/get-session", orchestratorUrl()), {
    cache: "no-store",
    headers: { cookie },
    signal: AbortSignal.timeout(8_000),
  });
  if (response.status === 401) return false;
  if (!response.ok) throw new Error("Authentication service unavailable");
  const body: unknown = await response.json();
  return (
    typeof body === "object" &&
    body !== null &&
    "session" in body &&
    !!body.session &&
    "user" in body &&
    !!body.user
  );
}

/** Every data route checks persisted sessions, including routes backed by demo data. */
export function withDashboardSession<Args extends unknown[]>(
  handler: (request: Request, ...args: Args) => Response | Promise<Response>,
) {
  return async (request: Request, ...args: Args): Promise<Response> => {
    const headers = {
      "cache-control": "no-store",
      "x-request-id": request.headers.get("x-request-id") ?? crypto.randomUUID(),
    };
    try {
      if (!(await getDashboardSession(request)))
        return Response.json(
          { error: "UNAUTHORIZED", message: "Sign in to continue." },
          { status: 401, headers },
        );
      const expectedOrigin = process.env.DASHBOARD_PUBLIC_URL ?? new URL(request.url).origin;
      if (
        !["GET", "HEAD", "OPTIONS"].includes(request.method) &&
        request.headers.get("origin") !== expectedOrigin
      ) {
        return Response.json(
          { error: "FORBIDDEN", message: "Invalid request origin." },
          { status: 403, headers },
        );
      }
      return await dashboardRequest.run(request, () => handler(request, ...args));
    } catch {
      return Response.json(
        { error: "AUTH_UNAVAILABLE", message: "Authentication is currently unavailable." },
        { status: 502, headers },
      );
    }
  };
}
