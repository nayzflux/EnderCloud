import { NextResponse } from "next/server";

const fallbackOrchestratorUrl = "http://localhost:8080";

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
    return new NextResponse(body, {
      status: response.status,
      headers: {
        "content-type": response.headers.get("content-type") ?? "application/json",
        "cache-control": "no-store",
        ...(response.headers.get("x-request-id")
          ? { "x-request-id": response.headers.get("x-request-id")! }
          : {}),
      },
    });
  } catch {
    return NextResponse.json(
      {
        error: "UPSTREAM_UNAVAILABLE",
        message: "L’orchestrateur EnderCloud est momentanément inaccessible.",
      },
      { status: 502, headers: { "cache-control": "no-store" } },
    );
  } finally {
    clearTimeout(timeout);
  }
}
