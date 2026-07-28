import { openapi } from "@elysiajs/openapi";
import { Elysia, t } from "elysia";
import type { Logger } from "../logger.ts";
import type { DashboardService } from "../services/dashboard-service.ts";
import type { InstanceController } from "../services/instance-controller.ts";
import type { QueueService } from "../services/queue-service.ts";
import { nanoid } from "../id.ts";

const playerUuid = t.String({ format: "uuid" });
const internalId = t.String({ pattern: "^[A-Za-z0-9]{16}$" });
const groupId = t.String({ pattern: "^[a-z0-9][a-z0-9-]{1,62}$" });
const paperEventSchema = t.Union([
  t.Object({ type: t.Literal("SERVER_READY"), endpoint: t.Optional(t.String()) }),
  t.Object({
    type: t.Literal("PLAYER_JOINED"),
    playerId: playerUuid,
    sessionId: t.Optional(internalId),
  }),
  t.Object({
    type: t.Literal("PLAYER_LEFT"),
    playerId: playerUuid,
    sessionId: t.Optional(internalId),
  }),
  t.Object({ type: t.Literal("HEARTBEAT"), playerIds: t.Array(playerUuid) }),
  t.Object({ type: t.Literal("GAME_STARTING"), sessionId: internalId }),
  t.Object({ type: t.Literal("GAME_STARTED"), sessionId: internalId }),
  t.Object({
    type: t.Literal("GAME_CANCELLED"),
    sessionId: internalId,
    reason: t.Optional(t.String({ maxLength: 512 })),
  }),
  t.Object({
    type: t.Literal("GAME_FINISHED"),
    sessionId: internalId,
    results: t.Optional(t.Unknown()),
  }),
]);

export interface ApiDependencies {
  readonly queues: QueueService;
  readonly instances: InstanceController;
  readonly dashboard: DashboardService;
  readonly logger: Logger;
  readonly isReady: () => boolean;
}

// Build the HTTP API and bind each route to the orchestrator services.
export function createApp(dependencies: ApiDependencies) {
  return new Elysia({ name: "endercloud-api" })
    .use(
      openapi({
        documentation: {
          info: {
            title: "EnderCloud internal API",
            version: "1.0.0",
            description: "Private network API used by EnderCloud Paper and Velocity bridges.",
          },
        },
      }),
    )
    .onRequest(({ request, store }) => {
      (store as { requestId?: string }).requestId =
        request.headers.get("x-request-id") ?? nanoid();
    })
    .onAfterHandle(({ set, store }) => {
      set.headers["x-request-id"] = (store as { requestId?: string }).requestId ?? "";
    })
    .onError(({ error, code, set, store }) => {
      const requestId = (store as { requestId?: string }).requestId;
      const message = error instanceof Error ? error.message : String(error);
      if (code === "VALIDATION") {
        set.status = 400;
        return { error: "VALIDATION_ERROR", message, requestId };
      }
      if (/unavailable|larger|already|distinct|not lock eligible/i.test(message)) {
        set.status = 409;
        return { error: "CONFLICT", message, requestId };
      }
      dependencies.logger.error("API request failed", { code, message, requestId });
      set.status = 500;
      return { error: "INTERNAL_ERROR", message: "Internal server error", requestId };
    })
    .get("/health/live", () => ({ status: "UP" }), {
      detail: { tags: ["Health"] },
    })
    .get(
      "/health/ready",
      ({ set }) => {
        if (!dependencies.isReady()) set.status = 503;
        return { status: dependencies.isReady() ? "READY" : "NOT_READY" };
      },
      { detail: { tags: ["Health"] } },
    )
    .group("/api/v1", (api) =>
      api
        .get("/proxy/servers", () => dependencies.instances.listProxyServers(), {
          detail: { tags: ["Proxy"] },
        })
        .get("/dashboard/cluster", () => dependencies.dashboard.getCluster(), {
          detail: {
            tags: ["Dashboard"],
            summary: "Read the current cluster topology",
          },
        })
        .get(
          "/dashboard/groups/:groupId/queue",
          async ({ params, query, set, store }) => {
            const detail = await dependencies.dashboard.getQueue(
              params.groupId,
              query.limit,
            );
            if (detail) return detail;
            set.status = 404;
            return {
              error: "NOT_FOUND",
              message: `Server group ${params.groupId} was not found`,
              requestId: (store as { requestId?: string }).requestId,
            };
          },
          {
            params: t.Object({ groupId }),
            query: t.Object({
              limit: t.Optional(t.Numeric({ minimum: 1, maximum: 200 })),
            }),
            detail: {
              tags: ["Dashboard"],
              summary: "Read the oldest queued parties for a server group",
            },
          },
        )
        .get(
          "/dashboard/instances/:instanceId",
          async ({ params, set, store }) => {
            const detail = await dependencies.dashboard.getInstance(params.instanceId);
            if (detail) return detail;
            set.status = 404;
            return {
              error: "NOT_FOUND",
              message: `Instance ${params.instanceId} was not found`,
              requestId: (store as { requestId?: string }).requestId,
            };
          },
          {
            params: t.Object({ instanceId: internalId }),
            detail: {
              tags: ["Dashboard"],
              summary: "Read operational details for an instance",
            },
          },
        )
        .get(
          "/dashboard/sessions/:sessionId",
          async ({ params, set, store }) => {
            const detail = await dependencies.dashboard.getSession(params.sessionId);
            if (detail) return detail;
            set.status = 404;
            return {
              error: "NOT_FOUND",
              message: `Session ${params.sessionId} was not found`,
              requestId: (store as { requestId?: string }).requestId,
            };
          },
          {
            params: t.Object({ sessionId: internalId }),
            detail: {
              tags: ["Dashboard"],
              summary: "Read tickets, feasible profiles and transfers for a game session",
            },
          },
        )
        .post(
          "/proxy/players/:playerId/disconnected",
          async ({ params, set }) => {
            await dependencies.queues.networkDisconnected(params.playerId);
            set.status = 204;
          },
          {
            params: t.Object({ playerId: playerUuid }),
            detail: { tags: ["Proxy"] },
          },
        )
        .post(
          "/queue/entries",
          async ({ body, set }) => {
            const result = await dependencies.queues.enqueue(body);
            set.status = 201;
            return result;
          },
          {
            body: t.Object({
              groupId: t.String({ minLength: 2, maxLength: 63 }),
              partyId: t.String({ minLength: 1, maxLength: 128 }),
              players: t.Array(playerUuid, { minItems: 1 }),
            }),
            detail: { tags: ["Matchmaking"] },
          },
        )
        .delete(
          "/queue/groups/:groupId/parties/:partyId",
          async ({ params, set }) => {
            const removed = await dependencies.queues.leaveParty(
              params.groupId,
              params.partyId,
            );
            if (!removed) set.status = 404;
            return { removed };
          },
          {
            params: t.Object({
              groupId: t.String({ minLength: 2, maxLength: 63 }),
              partyId: t.String({ minLength: 1, maxLength: 128 }),
            }),
            detail: { tags: ["Matchmaking"] },
          },
        )
        .post(
          "/instances/:instanceId/events",
          async ({ params, body, set }) => {
            await dependencies.instances.handlePaperEvent(params.instanceId, body);
            set.status = 202;
            return { accepted: true };
          },
          {
            params: t.Object({ instanceId: internalId }),
            body: paperEventSchema,
            detail: { tags: ["Paper"] },
          },
        )
        .get(
          "/instances/:instanceId/assignment",
          async ({ params, set }) => {
            const assignment = await dependencies.instances.getAssignment(params.instanceId);
            if (!assignment) set.status = 404;
            return assignment ?? { error: "NO_ASSIGNMENT" };
          },
          {
            params: t.Object({ instanceId: internalId }),
            detail: { tags: ["Paper"] },
          },
        )
        .post(
          "/instances/:instanceId/assignment/:revision/ack",
          async ({ params, set }) => {
            const acknowledged = await dependencies.instances.acknowledgeAssignment(
              params.instanceId,
              Number.parseInt(params.revision, 10),
            );
            if (!acknowledged) set.status = 409;
            return { acknowledged };
          },
          {
            params: t.Object({
              instanceId: internalId,
              revision: t.String({ pattern: "^[1-9][0-9]*$" }),
            }),
            detail: { tags: ["Paper"] },
          },
        ),
    );
}
