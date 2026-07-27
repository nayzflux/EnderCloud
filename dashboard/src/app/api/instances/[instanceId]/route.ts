import { NextResponse } from "next/server";
import { proxyOrchestrator } from "@/lib/orchestrator-proxy";

const internalIdPattern = /^[A-Za-z0-9]{16}$/;

export async function GET(
  _request: Request,
  context: { params: Promise<{ instanceId: string }> },
) {
  const { instanceId } = await context.params;
  if (!internalIdPattern.test(instanceId)) {
    return NextResponse.json(
      { error: "VALIDATION_ERROR", message: "Identifiant d’instance invalide." },
      { status: 400 },
    );
  }
  return proxyOrchestrator(
    `/api/v1/dashboard/instances/${encodeURIComponent(instanceId)}`,
  );
}
