import { proxyOrchestrator } from "@/lib/orchestrator-proxy";

export const dynamic = "force-dynamic";

export function GET() {
  return proxyOrchestrator("/api/v1/dashboard/cluster");
}
