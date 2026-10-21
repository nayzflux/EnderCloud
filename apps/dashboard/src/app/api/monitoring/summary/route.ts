import { isMockEnabled, mockMonitoringSummary } from "@/lib/mock-data";
import { jsonResponse, proxyOrchestrator } from "@/lib/orchestrator-proxy";

export const dynamic = "force-dynamic";

export function GET() {
  if (isMockEnabled()) return jsonResponse(mockMonitoringSummary());
  return proxyOrchestrator("/api/v1/dashboard/monitoring/summary");
}
