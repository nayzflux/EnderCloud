import { Elysia, t } from "elysia";
import { ApplicationError, denyUnauthorized, type RequestAuthorizer } from "@endercloud/contracts/errors";
import { instanceCreateSchema } from "@endercloud/contracts/schemas";
import type { AgentConfig } from "./config.ts";
import type { TemplateCache } from "./template-cache.ts";
import type { LocalDockerExecutor } from "./docker-executor.ts";
import type { Logger } from "@endercloud/runtime/logger";
import { nanoid } from "@endercloud/runtime/id";

const internalId = t.String({ pattern: "^[A-Za-z0-9]{16}$" });
const groupId = t.String({ pattern: "^[a-z0-9][a-z0-9-]{1,62}$" });
interface RequestContext {
  readonly requestId: string;
  readonly commandId: string | undefined;
  readonly startedAt: number;
  requestError?: unknown;
}

export function createAgentApp(
  config: AgentConfig,
  executor: LocalDockerExecutor,
  templates: TemplateCache,
  logger?: Logger,
  authorize: RequestAuthorizer = denyUnauthorized,
) {
  const requestContexts = new WeakMap<Request, RequestContext>();
  const contextFor = (request: Request): RequestContext => {
    const context = requestContexts.get(request);
    if (!context) {
      throw new Error("Request context was not initialized");
    }
    return context;
  };
  return new Elysia({ name: "endercloud-agent" })
    .onRequest(async ({ request }) => {
      const context = {
        requestId: request.headers.get("x-request-id") ?? nanoid(),
        commandId: request.headers.get("x-command-id") ?? undefined,
        startedAt: performance.now(),
      };
      requestContexts.set(request, context);
      logger?.enterContext({
        requestId: context.requestId,
        commandId: context.commandId,
      });
      if (!new URL(request.url).pathname.startsWith("/health/")) await authorize(request);
    })
    .onAfterHandle(({ request, set }) => {
      set.headers["x-request-id"] = contextFor(request).requestId;
    })
    .onError(({ request, error, code, set }) => {
      const message = error instanceof Error ? error.message : String(error);
      set.status = error instanceof ApplicationError ? error.status : code === "NOT_FOUND" ? 404 : code === "VALIDATION" || code === "PARSE" ? 400 : 500;
      const context = contextFor(request);
      const requestId = context.requestId;
      context.requestError = error;
      set.headers["x-request-id"] = requestId;
      return { error: error instanceof ApplicationError ? error.code : code, message: set.status === 500 ? "Internal agent error" : message, requestId };
    })
    .onAfterResponse(({ request, route, set }) => {
      const context = contextFor(request);
      const status = typeof set.status === "number" ? set.status : 200;
      const fields = {
        requestId: context.requestId,
        method: request.method,
        route,
        status,
        durationMs: Math.round(performance.now() - context.startedAt),
        outcome: status >= 500 ? "failure" : "success",
      };
      if (status >= 500) {
        logger?.error("agent.request.server_error", "Agent API request returned a server error", {
          ...fields,
          error: context.requestError,
        });
      }
      logger?.debug("agent.request.completed", "Agent API request completed", {
        ...fields,
      });
    })
    .get("/health/live", () => ({ status: "UP", hostId: config.hostId }))
    .get("/health/ready", async ({ set }) => {
      try {
        await executor.listManagedInstances(config.hostId);
        return { status: "READY", hostId: config.hostId };
      } catch {
        set.status = 503;
        return { status: "NOT_READY", hostId: config.hostId };
      }
    })
    .group("/api/v1", (api) => api
      .get("/instances", () => executor.listManagedInstances(config.hostId))
      .get(
        "/instances/:instanceId/logs",
        async ({ params, query }) => ({
          logs: await executor.getInstanceLogs(
            { hostId: config.hostId, instanceId: params.instanceId },
            query.lines,
            query.maxBytes,
          ),
        }),
        {
          params: t.Object({ instanceId: internalId }),
          query: t.Object({
            lines: t.Numeric({ minimum: 1, maximum: 1_000 }),
            maxBytes: t.Numeric({ minimum: 1, maximum: 262_144 }),
          }),
        },
      )
      .get(
        "/instances/:instanceId",
        ({ params }) => executor.inspectInstance({
          hostId: config.hostId,
          instanceId: params.instanceId,
        }),
        { params: t.Object({ instanceId: internalId }) },
      )
      .put(
        "/instances/:instanceId",
        async ({ params, body, request }) => {
          if (params.instanceId !== body.instanceId) {
            throw new ApplicationError("INVALID_REQUEST", 400, "Path and body instance ids differ");
          }
          if (body.hostId !== config.hostId) {
            throw new ApplicationError("FORBIDDEN", 403, "Host identity does not match this agent");
          }
          const templateLayers = await templates.resolveLayers(body.templateLayers, request.signal);
          return executor.createInstance({ ...body, templateLayers });
        },
        { params: t.Object({ instanceId: internalId }), body: instanceCreateSchema },
      )
      .post(
        "/instances/:instanceId/stop",
        async ({ params, body, set }) => {
          await executor.stopInstance(
            { hostId: config.hostId, instanceId: params.instanceId },
            body.timeoutSeconds,
          );
          set.status = 204;
        },
        {
          params: t.Object({ instanceId: internalId }),
          body: t.Object({ timeoutSeconds: t.Number({ minimum: 0, maximum: 600 }) }),
        },
      )
      .delete(
        "/instances/:instanceId",
        async ({ params, body, set }) => {
          if (body?.containerId) {
            const instances = await executor.listManagedInstances(config.hostId);
            const instance = instances.find((candidate) =>
              candidate.instanceId === params.instanceId &&
              candidate.containerId === body.containerId
            );
            if (!instance) {
              return { containerRemoved: false, runtimeDirectoryRemoved: false };
            }
            return executor.deleteOrphanInstance(instance);
          }
          await executor.deleteInstance({ hostId: config.hostId, instanceId: params.instanceId });
          set.status = 204;
        },
        {
          params: t.Object({ instanceId: internalId }),
          body: t.Optional(t.Object({ containerId: t.String({ minLength: 1 }) })),
        },
      ));
}
