import { z } from "zod";
import { lifecycleStates, sessionStates, sessionPlayerStates, executionHostHealthStates, executionHostAdminStates } from "./domain.ts";

export const internalIdSchema = z.string().regex(/^[A-Za-z0-9]{16}$/);
export const groupIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/);
export const playerIdSchema = z.uuid();
export const checksumSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const lifecycleStateSchema = z.enum(lifecycleStates);
export const sessionStateSchema = z.enum(sessionStates);
export const sessionPlayerStateSchema = z.enum(sessionPlayerStates);
export const hostHealthSchema = z.enum(executionHostHealthStates);
export const hostAdminStateSchema = z.enum(executionHostAdminStates);
export const positiveIntegerSchema = z.number().int().safe().positive();

const session = { sessionId: internalIdSchema };
export const paperEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("SERVER_READY"), endpoint: z.string().optional() }),
  z.object({ type: z.literal("PLAYER_JOINED"), playerId: playerIdSchema, sessionId: internalIdSchema.optional() }),
  z.object({ type: z.literal("PLAYER_LEFT"), playerId: playerIdSchema, sessionId: internalIdSchema.optional() }),
  z.object({ type: z.literal("PLAYER_ELIMINATED"), playerId: playerIdSchema, ...session }),
  z.object({ type: z.literal("HEARTBEAT"), playerIds: z.array(playerIdSchema).max(10_000), tps: z.object({
    oneMinute: z.number().min(0).max(100), fiveMinutes: z.number().min(0).max(100), fifteenMinutes: z.number().min(0).max(100),
  }).optional() }),
  z.object({ type: z.literal("GAME_STARTING"), ...session }),
  z.object({ type: z.literal("GAME_STARTED"), ...session }),
  z.object({ type: z.literal("GAME_CANCELLED"), ...session, reason: z.string().max(512).optional() }),
  z.object({ type: z.literal("GAME_FINISHED"), ...session, results: z.unknown().optional() }),
]);

export const instanceCreateSchema = z.object({
  instanceType: z.enum(["paper", "proxy"]),
  hostId: groupIdSchema, instanceId: internalIdSchema, groupId: groupIdSchema, variantId: groupIdSchema,
  sessionId: internalIdSchema.optional(),
  templateLayers: z.array(z.object({ id: groupIdSchema, checksum: checksumSchema })).min(1).max(128),
  runtime: z.object({ dataDirectory: z.string().regex(/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/).optional(),
    image: z.string().min(1), memoryBytes: positiveIntegerSchema, cpu: z.number().finite().positive(), environment: z.record(z.string(), z.string()) }),
  environment: z.record(z.string(), z.string()),
});

export const servicePrincipalSchema = z.object({ kind: z.enum(["agent", "paper", "proxy"]), principalId: z.string().min(1).max(128) });
export type ServicePrincipal = z.infer<typeof servicePrincipalSchema>;
