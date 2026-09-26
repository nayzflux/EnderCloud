import { Elysia, t } from "elysia";
import type { AgentConfig } from "./config.ts";
import type { TemplateCache } from "./template-cache.ts";
import type { LocalDockerExecutor } from "../executor/local-docker.ts";
import type { Logger } from "../logger.ts";
import { nanoid } from "../id.ts";

const internalId = t.String({ pattern: "^[A-Za-z0-9]{16}$" });
const groupId = t.String({ pattern: "^[a-z0-9][a-z0-9-]{1,62}$" });
const layerSchema = t.Object({
  id: groupId,
  checksum: t.String({ pattern: "^[a-f0-9]{64}$" }),
});
const instanceSchema = t.Object({
  hostId: groupId,
  instanceId: internalId,
  groupId,
  variantId: groupId,
  sessionId: t.Optional(internalId),
  templateLayers: t.Array(layerSchema, { minItems: 1 }),
  runtime: t.Object({
    image: t.String({ minLength: 1 }),
    memoryBytes: t.Number({ minimum: 1 }),
    cpu: t.Number({ exclusiveMinimum: 0 }),
    environment: t.Record(t.String(), t.String()),
  }),
  environment: t.Record(t.String(), t.String()),
});

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
    .onRequest(({ request }) => {
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
    })
    .onAfterHandle(({ request, set }) => {
      set.headers["x-request-id"] = contextFor(request).requestId;
    })
    .onError(({ request, error, code, set }) => {
      const message = error instanceof Error ? error.message : String(error);
      set.status = code === "VALIDATION" ? 400 : 500;
      const context = contextFor(request);
      const requestId = context.requestId;
      context.requestError = error;
      set.headers["x-request-id"] = requestId;
      return { error: code === "VALIDATION" ? "VALIDATION_ERROR" : "AGENT_ERROR", message, requestId };
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
        async ({ params, body }) => {
          if (params.instanceId !== body.instanceId) {
            throw new Error("Path and body instance ids differ");
          }
          if (body.hostId !== config.hostId) {
            throw new Error(`Agent ${config.hostId} cannot create for host ${body.hostId}`);
          }
          const templateLayers = await templates.resolveLayers(body.templateLayers);
          return executor.createInstance({ ...body, templateLayers });
        },
        { params: t.Object({ instanceId: internalId }), body: instanceSchema },
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
