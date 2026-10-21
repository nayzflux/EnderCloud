import { withDashboardSession } from "@/lib/server-session";
import type { MonitoringRange } from "@endercloud/contracts";
import { isMockEnabled, mockGroupMonitoring } from "@/features/demo/data.server";
import {
  jsonResponse,
  notFoundResponse,
  proxyOrchestrator,
  validationErrorResponse,
} from "@/lib/orchestrator-proxy";

export const dynamic = "force-dynamic";

const groupIdPattern = /^[a-z0-9][a-z0-9-]{1,62}$/;
const validRanges = new Set<MonitoringRange>(["1h", "6h", "24h", "7d"]);

export const GET = withDashboardSession(async (
  request: Request,
  context: { params: Promise<{ groupId: string }> },
) => {
  const { groupId } = await context.params;
  if (!groupIdPattern.test(groupId)) {
    return validationErrorResponse("Invalid group identifier.");
  }
  const range = new URL(request.url).searchParams.get("range") as MonitoringRange | null;
  if (!range || !validRanges.has(range)) {
    return validationErrorResponse("Range must be one of 1h, 6h, 24h or 7d.");
  }
  if (isMockEnabled()) {
    const detail = mockGroupMonitoring(groupId, range);
    return detail ? jsonResponse(detail) : notFoundResponse("Unknown group.");
  }
  return proxyOrchestrator(
    `/api/v1/dashboard/groups/${encodeURIComponent(groupId)}/monitoring?range=${range}`,
  );
});
