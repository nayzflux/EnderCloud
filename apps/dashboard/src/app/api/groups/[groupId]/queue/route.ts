import { withDashboardSession } from "@/lib/server-session";
import { isMockEnabled, mockQueue } from "@/features/demo/data.server";
import {
  jsonResponse,
  notFoundResponse,
  proxyOrchestrator,
  validationErrorResponse,
} from "@/lib/orchestrator-proxy";

export const dynamic = "force-dynamic";

const groupIdPattern = /^[a-z0-9][a-z0-9-]{1,62}$/;

export const GET = withDashboardSession(
  async (request: Request, context: { params: Promise<{ groupId: string }> }) => {
    const { groupId } = await context.params;
    if (!groupIdPattern.test(groupId)) {
      return validationErrorResponse("Invalid group identifier.");
    }
    const requestedLimit = Number.parseInt(
      new URL(request.url).searchParams.get("limit") ?? "50",
      10,
    );
    const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(200, requestedLimit)) : 50;

    if (isMockEnabled()) {
      const detail = mockQueue(groupId, limit);
      return detail ? jsonResponse(detail) : notFoundResponse("Unknown group.");
    }

    return proxyOrchestrator(
      `/api/v1/dashboard/groups/${encodeURIComponent(groupId)}/queue?limit=${limit}`,
    );
  },
);
