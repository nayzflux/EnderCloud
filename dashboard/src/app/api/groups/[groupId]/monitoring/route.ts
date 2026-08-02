import type { MonitoringRange } from "@/lib/contracts";
import { isMockEnabled, mockGroupMonitoring } from "@/lib/mock-data";
import {
  jsonResponse,
  notFoundResponse,
  proxyOrchestrator,
  validationErrorResponse,
} from "@/lib/orchestrator-proxy";

export const dynamic = "force-dynamic";

const groupIdPattern = /^[a-z0-9][a-z0-9-]{1,62}$/;
const validRanges = new Set<MonitoringRange>(["1h", "6h", "24h", "7d"]);

export async function GET(
  request: Request,
  context: { params: Promise<{ groupId: string }> },
) {
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
}
