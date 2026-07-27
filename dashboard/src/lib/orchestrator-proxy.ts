import { NextResponse } from "next/server";

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

export async function proxyOrchestrator(path: string): Promise<NextResponse> {
  const baseUrl = process.env.ORCHESTRATOR_URL ?? fallbackOrchestratorUrl;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(new URL(path, `${baseUrl.replace(/\/+$/, "")}/`), {
      cache: "no-store",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    const body = await response.text();
    const requestId = response.headers.get("x-request-id");
    return new NextResponse(body, {
      status: response.status,
      headers: {
        "content-type":
          response.headers.get("content-type") ?? "application/json",
        ...noStore,
        ...(requestId ? { "x-request-id": requestId } : {}),
      },
    });
  } catch {
    return jsonResponse(
      {
        error: "UPSTREAM_UNAVAILABLE",
        message: "The EnderCloud orchestrator is currently unreachable.",
      },
      502,
    );
  } finally {
    clearTimeout(timeout);
  }
}
