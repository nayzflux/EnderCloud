import { isMockEnabled, mockIncidents } from "@/lib/mock-data";
import { jsonResponse, proxyOrchestrator, validationErrorResponse } from "@/lib/orchestrator-proxy";

export const dynamic = "force-dynamic";

const allowed = new Set(["status", "severity", "kind", "groupId", "scopeId", "cursor", "limit"]);

export function GET(request: Request) {
  const query = new URL(request.url).searchParams;
  if ([...query.keys()].some((key) => !allowed.has(key))) {
    return validationErrorResponse("Unsupported incident filter.");
  }
  const status = query.get("status");
  const severity = query.get("severity");
  const kind = query.get("kind");
  const limit = Number(query.get("limit") ?? 50);
  if (status && !["active", "resolved", "all"].includes(status)) {
    return validationErrorResponse("Invalid incident status.");
  }
  if (severity && !["WARNING", "CRITICAL"].includes(severity)) {
    return validationErrorResponse("Invalid incident severity.");
  }
  if (kind && ![
    "CAPACITY_BLOCKED", "INSTANCE_FAILURE_LOOP", "HOST_UNAVAILABLE",
    "HOST_RECOVERY_STUCK", "HOST_MAINTENANCE_BLOCKED", "SESSION_RETRIES_EXHAUSTED",
    "TRANSFER_FAILURE_LOOP", "COMMAND_FAILURE_LOOP", "CONTROL_LOOP_FAILURE",
  ].includes(kind)) {
    return validationErrorResponse("Invalid incident type.");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    return validationErrorResponse("Incident limit must be between 1 and 200.");
  }
  if (isMockEnabled()) {
    const data = mockIncidents();
    const groupId = query.get("groupId");
    const scopeId = query.get("scopeId");
    const incidents = data.incidents.filter((incident) =>
      (!status || status === "all" || incident.status === status.toUpperCase())
      && (!severity || incident.severity === severity)
      && (!kind || incident.kind === kind)
      && (!groupId || incident.scope.groupId === groupId)
      && (!scopeId || incident.scope.id === scopeId)
    ).slice(0, limit);
    return jsonResponse({ ...data, incidents });
  }
  const suffix = query.size > 0 ? `?${query}` : "";
  return proxyOrchestrator(`/api/v1/dashboard/incidents${suffix}`);
}
