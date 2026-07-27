import { NextResponse } from "next/server";
import { proxyOrchestrator } from "@/lib/orchestrator-proxy";

const internalIdPattern = /^[A-Za-z0-9]{16}$/;

export async function GET(
  _request: Request,
  context: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await context.params;
  if (!internalIdPattern.test(sessionId)) {
    return NextResponse.json(
      { error: "VALIDATION_ERROR", message: "Identifiant de session invalide." },
      { status: 400 },
    );
  }
  return proxyOrchestrator(
    `/api/v1/dashboard/sessions/${encodeURIComponent(sessionId)}`,
  );
}
