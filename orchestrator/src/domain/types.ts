export const lifecycleStates = [
  "CREATING",
  "STARTING",
  "RUNNING",
  "DRAINING",
  "STOPPING",
  "STOPPED",
  "FAILED",
  "ORPHANED",
] as const;
export type LifecycleState = (typeof lifecycleStates)[number];

export const availabilityStates = ["OPEN", "RESERVED"] as const;
export type AvailabilityState = (typeof availabilityStates)[number];

export const sessionStates = [
  "FORMING",
  "WAITING_FOR_INSTANCE",
  "TRANSFERRING",
  "WAITING",
  "STARTING",
  "RUNNING",
  "FINISHED",
  "CANCELLED",
  "FAILED",
] as const;
export type SessionState = (typeof sessionStates)[number];

export const sessionPlayerStates = [
  "SELECTED",
  "TRANSFERRING",
  "CONNECTED",
  "LEFT",
] as const;
export type SessionPlayerState = (typeof sessionPlayerStates)[number];

export type GroupType = "hub" | "minigame";

export interface CapacityPolicy {
  readonly minimumInstances: number;
  readonly maximumInstances: number;
  readonly minimumWarmInstances: number;
  readonly maximumWarmInstances: number;
}

export interface MatchmakingPolicy {
  readonly minimumPlayers: number;
  readonly maximumPlayers: number;
  readonly teamCount: number;
  readonly teamSize: number;
  readonly candidateWindow: number;
  readonly minimumPlayersPerTeam: number;
  readonly maximumTeamSpread: number;
}

export interface TimeoutPolicy {
  readonly startupMs: number;
  readonly drainMs: number;
  readonly cancelledDrainMs: number;
  readonly shutdownMs: number;
  readonly transferMs: number;
  readonly playerStaleMs: number;
  readonly instanceLifetimeMs?: number;
  readonly instanceAcquisitionMs?: number;
  readonly lobbyStaleMs?: number;
}

export interface ServerGroupConfig {
  readonly id: string;
  readonly type: GroupType;
  readonly enabled: boolean;
  readonly variants: readonly GroupVariantReference[];
  readonly matchmaking?: MatchmakingPolicy;
  readonly capacity: CapacityPolicy;
  readonly timeouts: TimeoutPolicy;
  readonly routing?: {
    readonly maximumPlayersPerInstance: number;
    readonly targetPlayersPerInstance: number;
  };
}

export interface VariantRuntimeSpec {
  readonly image: string;
  readonly memoryBytes: number;
  readonly cpu: number;
  readonly environment: Readonly<Record<string, string>>;
}

export interface GroupVariantReference {
  readonly id: string;
  readonly enabled: boolean;
  readonly weight: number;
}

export interface VariantRuntimePatch {
  readonly image?: string;
  readonly memoryBytes?: number;
  readonly cpu?: number;
  readonly environment: Readonly<Record<string, string>>;
}

export interface TemplateFileSummary {
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly roots: readonly string[];
}

export interface ServerVariantConfig {
  readonly id: string;
  readonly revision?: number;
  readonly parents: readonly string[];
  readonly runtime: VariantRuntimePatch;
}

export interface TemplateLayerSpec extends ServerVariantConfig {
  readonly templatePath: string;
  readonly checksum: string;
  readonly files: TemplateFileSummary;
}

export interface ResolvedServerVariantConfig {
  readonly id: string;
  readonly revision: number;
  readonly checksum: string;
  readonly runtime: VariantRuntimeSpec;
  readonly layers: readonly TemplateLayerSpec[];
}

export interface QueueParty {
  readonly entryId: string;
  readonly partyId: string;
  readonly playerIds: readonly string[];
  readonly joinedAt: Date;
}

export interface RedisEnvelope<T = unknown> {
  readonly schemaVersion: 1;
  readonly eventId: string;
  readonly type:
    | "SERVER_REGISTERED"
    | "SERVER_UPDATED"
    | "SERVER_UNREGISTERED"
    | "TRANSFER_PLAYERS";
  readonly occurredAt: string;
  readonly payload: T;
}

export interface ServerSnapshot {
  readonly instanceId: string;
  readonly variantId: string;
  readonly groupId: string;
  readonly groupType: GroupType;
  readonly endpoint: string;
  readonly lifecycleState: LifecycleState;
  readonly availabilityState: AvailabilityState;
  readonly playerCount: number;
  readonly maximumPlayers: number;
}

export type PaperEvent =
  | { readonly type: "SERVER_READY"; readonly endpoint?: string }
  | { readonly type: "PLAYER_JOINED"; readonly playerId: string; readonly sessionId?: string }
  | { readonly type: "PLAYER_LEFT"; readonly playerId: string; readonly sessionId?: string }
  | { readonly type: "PLAYER_ELIMINATED"; readonly playerId: string; readonly sessionId: string }
  | { readonly type: "HEARTBEAT"; readonly playerIds: readonly string[] }
  | { readonly type: "GAME_STARTING"; readonly sessionId: string }
  | { readonly type: "GAME_STARTED"; readonly sessionId: string }
  | { readonly type: "GAME_CANCELLED"; readonly sessionId: string; readonly reason?: string }
  | { readonly type: "GAME_FINISHED"; readonly sessionId: string; readonly results?: unknown };
