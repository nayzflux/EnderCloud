import { Elysia, t } from "elysia";
import type { AgentConfig } from "./config.ts";
import type { TemplateCache } from "./template-cache.ts";
import type { LocalDockerExecutor } from "../executor/local-docker.ts";

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

export function createAgentApp(
  config: AgentConfig,
  executor: LocalDockerExecutor,
  templates: TemplateCache,
) {
  return new Elysia({ name: "endercloud-agent" })
    .onError(({ error, code, set }) => {
      const message = error instanceof Error ? error.message : String(error);
      set.status = code === "VALIDATION" ? 400 : 500;
      return { error: code === "VALIDATION" ? "VALIDATION_ERROR" : "AGENT_ERROR", message };
    })
    .get("/health/live", () => ({ status: "UP", hostId: config.hostId }))
    .group("/api/v1", (api) => api
      .get("/instances", () => executor.listManagedInstances(config.hostId))
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
