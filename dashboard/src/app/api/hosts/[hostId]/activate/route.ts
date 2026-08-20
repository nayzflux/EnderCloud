import { isMockEnabled } from "@/lib/mock-data";
import {
  jsonResponse,
  proxyOrchestrator,
  validationErrorResponse,
} from "@/lib/orchestrator-proxy";

export const dynamic = "force-dynamic";

const hostIdPattern = /^[a-z0-9][a-z0-9-]{1,62}$/;

export async function POST(
  _request: Request,
  context: { params: Promise<{ hostId: string }> },
) {
  const { hostId } = await context.params;
  if (!hostIdPattern.test(hostId)) {
    return validationErrorResponse("Invalid host identifier.");
  }
  if (isMockEnabled()) return jsonResponse({ accepted: true });
  return proxyOrchestrator(
    `/api/v1/hosts/${encodeURIComponent(hostId)}/activate`,
    { method: "POST" },
  );
}
