import { NextResponse } from "next/server";
import { proxyOrchestrator } from "@/lib/orchestrator-proxy";

const groupIdPattern = /^[a-z0-9][a-z0-9-]{1,62}$/;

export async function GET(
  request: Request,
  context: { params: Promise<{ groupId: string }> },
) {
  const { groupId } = await context.params;
  if (!groupIdPattern.test(groupId)) {
    return NextResponse.json(
      { error: "VALIDATION_ERROR", message: "Identifiant de groupe invalide." },
      { status: 400 },
    );
  }
  const requestedLimit = Number.parseInt(
    new URL(request.url).searchParams.get("limit") ?? "50",
    10,
  );
  const limit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(200, requestedLimit))
    : 50;
  return proxyOrchestrator(
    `/api/v1/dashboard/groups/${encodeURIComponent(groupId)}/queue?limit=${limit}`,
  );
}
