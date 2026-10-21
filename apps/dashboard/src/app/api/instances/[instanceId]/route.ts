import { withDashboardSession } from "@/lib/server-session";
import { isMockEnabled, mockInstance } from "@/features/demo/data.server";
import {
  jsonResponse,
  notFoundResponse,
  proxyOrchestrator,
  validationErrorResponse,
} from "@/lib/orchestrator-proxy";

export const dynamic = "force-dynamic";

const internalIdPattern = /^[A-Za-z0-9]{16}$/;

export const GET = withDashboardSession(
  async (_request: Request, context: { params: Promise<{ instanceId: string }> }) => {
    const { instanceId } = await context.params;
    if (!internalIdPattern.test(instanceId)) {
      return validationErrorResponse("Invalid instance identifier.");
    }

    if (isMockEnabled()) {
      const detail = mockInstance(instanceId);
      return detail ? jsonResponse(detail) : notFoundResponse("Unknown instance.");
    }

    return proxyOrchestrator(`/api/v1/dashboard/instances/${encodeURIComponent(instanceId)}`);
  },
);
