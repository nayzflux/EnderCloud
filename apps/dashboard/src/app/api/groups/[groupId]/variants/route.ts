import { isMockEnabled, mockVariantGraph } from "@/lib/mock-data";
import {
  jsonResponse,
  notFoundResponse,
  proxyOrchestrator,
  validationErrorResponse,
} from "@/lib/orchestrator-proxy";

export const dynamic = "force-dynamic";

const groupIdPattern = /^[a-z0-9][a-z0-9-]{1,62}$/;

export async function GET(
  _request: Request,
  context: { params: Promise<{ groupId: string }> },
) {
  const { groupId } = await context.params;
  if (!groupIdPattern.test(groupId)) {
    return validationErrorResponse("Invalid group identifier.");
  }
  if (isMockEnabled()) {
    const detail = mockVariantGraph(groupId);
    return detail ? jsonResponse(detail) : notFoundResponse("Unknown group.");
  }
  return proxyOrchestrator(
    `/api/v1/dashboard/groups/${encodeURIComponent(groupId)}/variants`,
  );
}
