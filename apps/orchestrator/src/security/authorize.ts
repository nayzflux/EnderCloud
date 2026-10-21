import { and, eq } from "drizzle-orm";
import { ApplicationError, type RequestAuthorizer } from "@endercloud/contracts/errors";
import { servicePrincipalSchema } from "@endercloud/contracts/schemas";
import type { Database } from "../db/client.ts";
import { serverInstances, serverGroups, serviceCredentials } from "../db/schema.ts";
import type { Authentication } from "./auth.ts";

export function createAuthorizer(db: Database, auth: Authentication): RequestAuthorizer {
  return async request => {
    const path = new URL(request.url).pathname;
    const token = request.headers.get("authorization")?.match(/^Bearer (\S+)$/i)?.[1];
    if (!token) {
      const session = await auth.api.getSession({ headers: request.headers });
      if (!session) throw new ApplicationError("UNAUTHORIZED", 401, "Administrator session required");
      if (!["GET", "HEAD", "OPTIONS"].includes(request.method) && request.headers.get("origin") !== auth.options.baseURL) {
        throw new ApplicationError("FORBIDDEN", 403, "Invalid request origin");
      }
      return;
    }
    const result = await auth.api.verifyApiKey({ body: { key: token, configId: "service" } });
    if (!result.valid || !result.key) throw new ApplicationError("UNAUTHORIZED", 401, "Invalid service credential");
    const parsed = servicePrincipalSchema.safeParse(result.key.metadata);
    if (!parsed.success) throw new ApplicationError("FORBIDDEN", 403, "Invalid service identity");
    const { kind, principalId } = parsed.data;
    const [binding] = await db.select({ key: serviceCredentials.authKeyId }).from(serviceCredentials)
      .where(and(eq(serviceCredentials.kind, kind), eq(serviceCredentials.principalId, principalId)));
    if (binding?.key !== result.key.id) throw new ApplicationError("UNAUTHORIZED", 401, "Revoked service credential");
    const prefix = "/api/v1";
    let allowed = false;
    if (kind === "agent") {
      allowed = request.method === "PUT" && path === `${prefix}/hosts/${encodeURIComponent(principalId)}/heartbeat`
        || request.method === "GET" && /^\/api\/v1\/template-layers\/[a-z0-9-]+\/archive$/.test(path);
    } else {
      const [instance] = await db.select({ state: serverInstances.lifecycleState, type: serverGroups.type })
        .from(serverInstances).innerJoin(serverGroups, eq(serverGroups.id, serverInstances.groupId)).where(eq(serverInstances.id, principalId));
      if (!instance || ["FAILED", "STOPPED"].includes(instance.state) || (instance.type === "proxy") !== (kind === "proxy")) {
        throw new ApplicationError("FORBIDDEN", 403, "Service instance is inactive");
      }
      allowed = request.method === "POST" && path === `${prefix}/queue/entries`
        || request.method === "DELETE" && /^\/api\/v1\/queue\/groups\/[^/]+\/parties\/[^/]+$/.test(path);
      if (kind === "paper") allowed ||= (
        request.method === "GET" && path === `${prefix}/instances/${principalId}/assignment`
        || request.method === "POST" && (path === `${prefix}/instances/${principalId}/events`
          || path === `${prefix}/instances/${principalId}/hub-transfers`
          || new RegExp(`^${prefix}/instances/${principalId}/assignment/[1-9][0-9]*/ack$`).test(path)));
      if (kind === "proxy") allowed ||= (
        request.method === "GET" && path === `${prefix}/proxy/servers`
        || request.method === "PUT" && path === `${prefix}/proxies/${principalId}/heartbeat`
        || request.method === "POST" && (/^\/api\/v1\/proxy\/players\/[^/]+\/disconnected$/.test(path)
          || new RegExp(`^${prefix}/proxies/${principalId}/transfers/[^/]+/players/[^/]+/abandon$`).test(path)));
    }
    if (!allowed) throw new ApplicationError("FORBIDDEN", 403, "Service credential does not grant access to this resource");
  };
}
