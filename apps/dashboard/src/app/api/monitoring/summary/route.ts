import { withDashboardSession } from "@/lib/server-session";
import { isMockEnabled, mockMonitoringSummary } from "@/features/demo/data.server";
import { jsonResponse, proxyOrchestrator } from "@/lib/orchestrator-proxy";

export const dynamic = "force-dynamic";

export const GET = withDashboardSession(async () => {
  if (isMockEnabled()) return jsonResponse(mockMonitoringSummary());
  return proxyOrchestrator("/api/v1/dashboard/monitoring/summary");
});
