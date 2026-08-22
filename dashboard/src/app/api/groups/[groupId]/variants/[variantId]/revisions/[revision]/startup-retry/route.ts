import { isMockEnabled } from "@/lib/mock-data";
import {
  jsonResponse,
  proxyOrchestrator,
  validationErrorResponse,
} from "@/lib/orchestrator-proxy";

export const dynamic = "force-dynamic";

const idPattern = /^[a-z0-9][a-z0-9-]{1,62}$/;
const revisionPattern = /^[1-9][0-9]*$/;

export async function POST(
  _request: Request,
  context: { readonly params: Promise<{ groupId: string; variantId: string; revision: string }> },
) {
  const { groupId, variantId, revision } = await context.params;
  if (!idPattern.test(groupId) || !idPattern.test(variantId) || !revisionPattern.test(revision)) {
    return validationErrorResponse("Invalid group, variant or revision identifier.");
  }
  if (isMockEnabled()) {
    return jsonResponse({
      state: "RESETTING",
      failureCount: 6,
      retryLimit: 5,
      nextRetryAt: null,
      lastFailureAt: new Date().toISOString(),
      lastFailedInstanceId: null,
      lastFailureReason: "STARTUP_TIMEOUT",
    }, 202);
  }
  return proxyOrchestrator(
    `/api/v1/groups/${encodeURIComponent(groupId)}/variants/${encodeURIComponent(variantId)}/revisions/${encodeURIComponent(revision)}/startup-retry`,
    { method: "POST" },
  );
}
