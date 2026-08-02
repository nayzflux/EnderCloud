export type GroupType = "hub" | "minigame";
export type LifecycleState =
  | "CREATING"
  | "STARTING"
  | "RUNNING"
  | "DRAINING"
  | "STOPPING"
  | "STOPPED"
  | "FAILED"
  | "ORPHANED";
export type AvailabilityState = "OPEN" | "RESERVED";
export type SessionState =
  | "FORMING"
  | "WAITING_FOR_INSTANCE"
  | "TRANSFERRING"
  | "WAITING"
  | "STARTING"
  | "RUNNING"
  | "FINISHED"
  | "CANCELLED"
  | "FAILED";
export type SessionPlayerState =
  | "SELECTED"
  | "TRANSFERRING"
  | "CONNECTED"
  | "LEFT";

export interface VariantRuntimeSpec {
  readonly image: string;
  readonly memoryBytes: number;
  readonly cpu: number;
  readonly environment: Readonly<Record<string, string>>;
}

export interface DashboardVariant {
  readonly id: string;
  readonly enabled: boolean;
  readonly revision: number;
  readonly weight: number;
  readonly runtime: VariantRuntimeSpec;
}

export interface VariantRuntimePatch {
  readonly image?: string;
  readonly memoryBytes?: number;
  readonly cpu?: number;
  readonly environment: Readonly<Record<string, string>>;
}

export interface DashboardVariantGraph {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly groupId: string;
  readonly layers: readonly {
    readonly id: string;
    readonly checksum: string;
    readonly runtime: VariantRuntimePatch;
    readonly files: {
      readonly fileCount: number;
      readonly totalBytes: number;
      readonly roots: readonly string[];
    };
  }[];
  readonly variants: readonly (DashboardVariant & {
    readonly checksum: string;
    readonly layers: readonly string[];
  })[];
}

export type ActiveDeadlineKind =
  | "INSTANCE_STARTUP"
  | "INSTANCE_RENEWAL"
  | "INSTANCE_DRAIN"
  | "CANCELLED_INSTANCE_DRAIN"
  | "INSTANCE_SHUTDOWN"
  | "INSTANCE_ACQUISITION"
  | "PLAYER_TRANSFER"
  | "LOBBY_STALE";

export interface ActiveDeadline {
  readonly kind: ActiveDeadlineKind;
  readonly at: string;
}

export interface DashboardInstance {
  readonly id: string;
  readonly variantId: string;
  readonly sessionId: string | null;
  readonly lifecycleState: LifecycleState;
  readonly availabilityState: AvailabilityState;
  readonly endpoint: string | null;
  readonly playerCount: number;
  readonly maximumPlayers: number;
  readonly createdAt: string;
  readonly startingAt: string | null;
  readonly startupDeadline: string | null;
  readonly runningAt: string | null;
  readonly renewalDeadline: string | null;
  readonly replacesInstanceId: string | null;
  readonly drainingAt: string | null;
  readonly drainDeadline: string | null;
  readonly drainReason: string | null;
  readonly stoppingAt: string | null;
  readonly shutdownDeadline: string | null;
  readonly updatedAt: string;
}

export interface DashboardSession {
  readonly id: string;
  readonly instanceId: string | null;
  readonly state: SessionState;
  readonly assignmentRevision: number;
  readonly assignmentAcknowledgedAt: string | null;
  readonly instanceAcquisitionDeadline: string | null;
  readonly lobbyStaleDeadline: string | null;
  readonly retryCount: number;
  readonly maximumPlayerCount: number;
  readonly activePlayerCount: number;
  readonly connectedPlayerCount: number;
  readonly teamCount: number;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly updatedAt: string;
}

export interface DashboardGroup {
  readonly id: string;
  readonly type: GroupType;
  readonly enabled: boolean;
  readonly capacity: {
    readonly minimumInstances: number;
    readonly maximumInstances: number;
    readonly minimumWarmInstances: number;
    readonly maximumWarmInstances: number;
    readonly activeInstances: number;
    readonly warmInstances: number;
    readonly pendingWarmInstances: number;
    readonly reservedInstances: number;
  };
  readonly timeouts: {
    readonly startupMs: number;
    readonly drainMs: number;
    readonly cancelledDrainMs: number;
    readonly shutdownMs: number;
    readonly transferMs: number;
    readonly playerStaleMs: number;
    readonly instanceLifetimeMs: number | null;
    readonly instanceAcquisitionMs: number | null;
    readonly lobbyStaleMs: number | null;
  };
  readonly matchmaking: {
    readonly minimumPlayers: number;
    readonly maximumPlayers: number;
    readonly teamCount: number;
    readonly teamSize: number;
    readonly candidateWindow: number;
    readonly minimumPlayersPerTeam: number;
    readonly maximumTeamSpread: number;
  } | null;
  readonly routing: {
    readonly maximumPlayersPerInstance: number;
    readonly targetPlayersPerInstance: number;
  } | null;
  readonly queue: {
    readonly partyCount: number;
    readonly playerCount: number;
    readonly oldestJoinedAt: string | null;
  };
  readonly variants: readonly DashboardVariant[];
  readonly instances: readonly DashboardInstance[];
  readonly sessions: readonly DashboardSession[];
}

export interface DashboardClusterSnapshot {
  readonly schemaVersion: 2;
  readonly generatedAt: string;
  readonly summary: {
    readonly enabledGroups: number;
    readonly activeInstances: number;
    readonly runningInstances: number;
    readonly warmInstances: number;
    readonly pendingWarmInstances: number;
    readonly reservedInstances: number;
    readonly playersOnline: number;
    readonly activeSessions: number;
    readonly queuedParties: number;
    readonly queuedPlayers: number;
  };
  readonly groups: readonly DashboardGroup[];
}

export const monitoringRanges = ["1h", "6h", "24h", "7d"] as const;
export type MonitoringRange = (typeof monitoringRanges)[number];

export interface DashboardMonitoringSeries {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly groupId: string;
  readonly range: MonitoringRange;
  readonly resolutionMs: number;
  readonly thresholds: {
    readonly tps: number;
    readonly startupBootMs: number;
  };
  readonly variants: readonly {
    readonly variantId: string;
    readonly enabled: boolean;
    readonly startup: readonly {
      readonly at: string;
      readonly totalAverageMs: number;
      readonly bootAverageMs: number;
      readonly sampleCount: number;
    }[];
    readonly tps: readonly {
      readonly at: string;
      readonly oneMinute: number;
      readonly fiveMinutes: number;
      readonly fifteenMinutes: number;
      readonly sampleCount: number;
    }[];
  }[];
}

export type DashboardMonitoringAlert =
  | {
      readonly metric: "TPS_5M";
      readonly groupId: string;
      readonly variantId: string;
      readonly value: number;
      readonly threshold: number;
      readonly observedAt: string;
    }
  | {
      readonly metric: "STARTUP_BOOT_60M";
      readonly groupId: string;
      readonly variantId: string;
      readonly valueMs: number;
      readonly thresholdMs: number;
      readonly sampleCount: number;
      readonly observedAt: string;
    };

export interface DashboardMonitoringSummary {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly alerts: readonly DashboardMonitoringAlert[];
}

export interface DashboardQueueDetail {
  readonly schemaVersion: 2;
  readonly generatedAt: string;
  readonly groupId: string;
  readonly totalParties: number;
  readonly totalPlayers: number;
  readonly truncated: boolean;
  readonly entries: readonly {
    readonly id: string;
    readonly partyId: string;
    readonly joinedAt: string;
    readonly players: readonly string[];
  }[];
}

export interface DashboardInstanceDetail {
  readonly schemaVersion: 2;
  readonly generatedAt: string;
  readonly activeDeadline: ActiveDeadline | null;
  readonly instance: DashboardInstance & {
    readonly groupId: string;
    readonly groupType: GroupType;
    readonly containerId: string | null;
    readonly runtimePath: string | null;
    readonly stoppedAt: string | null;
  };
  readonly variant: DashboardVariant & { readonly checksum: string };
  readonly players: readonly {
    readonly playerId: string;
    readonly connectedAt: string;
    readonly lastSeenAt: string;
  }[];
  readonly session: DashboardSession | null;
  readonly commands: readonly {
    readonly id: string;
    readonly operation: string;
    readonly state: string;
    readonly attempts: number;
    readonly payload: unknown;
    readonly lastError: string | null;
    readonly createdAt: string;
    readonly completedAt: string | null;
  }[];
  readonly events: readonly {
    readonly id: string;
    readonly type: string;
    readonly payload: unknown;
    readonly createdAt: string;
  }[];
}

export interface DashboardSessionDetail {
  readonly schemaVersion: 2;
  readonly generatedAt: string;
  readonly activeDeadline: ActiveDeadline | null;
  readonly session: DashboardSession & { readonly groupId: string };
  readonly tickets: readonly {
    readonly ticketId: string;
    readonly partyId: string;
    readonly transferStartedAt: string | null;
    readonly players: readonly {
      readonly playerId: string;
      readonly partyId: string;
      readonly state: SessionPlayerState;
      readonly selectedAt: string;
      readonly transferringAt: string | null;
      readonly connectedAt: string | null;
      readonly leftAt: string | null;
    }[];
  }[];
  readonly expectedProfiles: readonly (readonly number[])[];
  readonly connectedProfiles: readonly (readonly number[])[];
  readonly recommendedExpectedProfile: readonly number[] | null;
  readonly recommendedConnectedProfile: readonly number[] | null;
  readonly transfers: readonly {
    readonly id: string;
    readonly instanceId: string;
    readonly state: string;
    readonly attempts: number;
    readonly nextAttemptAt: string;
    readonly expiresAt: string;
    readonly createdAt: string;
    readonly completedAt: string | null;
  }[];
}
