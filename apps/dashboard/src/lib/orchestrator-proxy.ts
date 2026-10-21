import { NextResponse } from "next/server";
import { dashboardRequest } from "./server-session";

const fallbackOrchestratorUrl = "http://localhost:8080";

const noStore = { "cache-control": "no-store" } as const;

/** JSON response used by mock mode and by the routes' own input validation. */
export function jsonResponse(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: noStore });
}

export function notFoundResponse(message: string): NextResponse {
  return jsonResponse({ error: "NOT_FOUND", message }, 404);
}

export function validationErrorResponse(message: string): NextResponse {
  return jsonResponse({ error: "VALIDATION_ERROR", message }, 400);
}

export async function proxyOrchestrator(
  path: string,
  init: Pick<RequestInit, "method" | "body"> = {},
): Promise<NextResponse> {
  const baseUrl = process.env.ORCHESTRATOR_URL ?? fallbackOrchestratorUrl;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const incoming = dashboardRequest.getStore();
    const requestId = incoming?.headers.get("x-request-id") ?? crypto.randomUUID();
    const response = await fetch(new URL(path, `${baseUrl.replace(/\/+$/, "")}/`), {
      cache: "no-store",
      method: init.method ?? "GET",
      body: init.body,
      headers: {
        accept: "application/json",
        "x-request-id": requestId,
        ...(incoming?.headers.get("cookie") ? { cookie: incoming.headers.get("cookie")! } : {}),
        ...(incoming?.headers.get("origin") ? { origin: incoming.headers.get("origin")! } : {}),
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
      signal: incoming ? AbortSignal.any([controller.signal, incoming.signal]) : controller.signal,
    });
    const body = [204, 205, 304].includes(response.status) ? null : await response.text();
    const headers = new Headers({ ...noStore, "x-request-id": response.headers.get("x-request-id") ?? requestId });
    if (response.headers.has("content-type")) headers.set("content-type", response.headers.get("content-type")!);
    for (const cookie of response.headers.getSetCookie()) headers.append("set-cookie", cookie);
    return new NextResponse(body, {
      status: response.status,
      headers,
    });
  } catch {
    return jsonResponse(
      {
        error: "UPSTREAM_UNAVAILABLE",
        message: "The EnderCloud orchestrator is currently unreachable.",
      },
      controller.signal.aborted ? 504 : 502,
    );
  } finally {
    clearTimeout(timeout);
  }
}
