import { isMockEnabled, mockSession } from "@/lib/mock-data";
import {
  jsonResponse,
  notFoundResponse,
  proxyOrchestrator,
  validationErrorResponse,
} from "@/lib/orchestrator-proxy";

export const dynamic = "force-dynamic";

const internalIdPattern = /^[A-Za-z0-9]{16}$/;

export async function GET(
  _request: Request,
  context: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await context.params;
  if (!internalIdPattern.test(sessionId)) {
    return validationErrorResponse("Invalid session identifier.");
  }

  if (isMockEnabled()) {
    const detail = mockSession(sessionId);
    return detail ? jsonResponse(detail) : notFoundResponse("Unknown session.");
  }

  return proxyOrchestrator(
    `/api/v1/dashboard/sessions/${encodeURIComponent(sessionId)}`,
  );
}
