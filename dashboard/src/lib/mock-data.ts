import type {
  AvailabilityState,
  DashboardClusterSnapshot,
  DashboardGroup,
  DashboardInstance,
  DashboardInstanceDetail,
  DashboardQueueDetail,
  DashboardSession,
  DashboardSessionDetail,
  DashboardVariant,
  DashboardVariantGraph,
  ActiveDeadlineKind,
  GroupType,
  LifecycleState,
  SessionPlayerState,
  SessionState,
  VariantRuntimePatch,
} from "./contracts";

/**
 * Synthetic cluster used when `DASHBOARD_MOCK_DATA` is enabled, so the console
 * can be developed and demoed without an orchestrator, Docker or PostgreSQL.
 *
 * The world is rebuilt from a fixed seed on every request: identifiers stay
 * stable across refreshes (detail routes keep resolving), while every timestamp
 * is expressed as an offset from "now" so ages, deadlines and queue waits keep
 * ticking like a live cluster.
 */

const ID_ALPHABET =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const HEX = "0123456789abcdef";
const WORLD_SEED = 0x5eed_c10d;

export function isMockEnabled(): boolean {
  const flag = process.env.DASHBOARD_MOCK_DATA?.trim().toLowerCase();
  return flag === "1" || flag === "true" || flag === "yes" || flag === "on";
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function pick<T>(random: () => number, values: readonly T[]): T {
  return values[Math.floor(random() * values.length) % values.length];
}

function between(random: () => number, min: number, max: number): number {
  return Math.floor(min + random() * (max - min + 1));
}

function internalId(random: () => number): string {
  let id = "";
  for (let index = 0; index < 16; index += 1) {
    id += ID_ALPHABET[Math.floor(random() * ID_ALPHABET.length)];
  }
  return id;
}

function uuid(random: () => number): string {
  let raw = "";
  for (let index = 0; index < 32; index += 1) {
    raw += HEX[Math.floor(random() * HEX.length)];
  }
  return [
    raw.slice(0, 8),
    raw.slice(8, 12),
    `4${raw.slice(13, 16)}`,
    `a${raw.slice(17, 20)}`,
    raw.slice(20, 32),
  ].join("-");
}

/** ISO timestamp `secondsAgo` seconds in the past (negative = future). */
function ago(now: number, secondsAgo: number): string {
  return new Date(now - secondsAgo * 1_000).toISOString();
}

interface VariantBlueprint {
  readonly id: string;
  readonly weight: number;
  readonly image: string;
  readonly memoryGiB: number;
  readonly cpu: number;
  readonly enabled?: boolean;
}

interface InstanceBlueprint {
  readonly lifecycleState: LifecycleState;
  readonly availabilityState: AvailabilityState;
  readonly variantIndex?: number;
  /** Fraction of `maximumPlayers` currently connected. */
  readonly load?: number;
  readonly ageSeconds: number;
  readonly drainReason?: "NORMAL" | "SESSION_CANCELLED" | "HUB_RENEWAL";
  readonly session?: SessionBlueprint;
}

interface SessionBlueprint {
  readonly state: SessionState;
  readonly ageSeconds: number;
  readonly players: number;
  readonly connected: number;
  readonly detached?: boolean;
  readonly deadlineKind?: Extract<
    ActiveDeadlineKind,
    "PLAYER_TRANSFER" | "LOBBY_STALE"
  >;
}

interface GroupBlueprint {
  readonly id: string;
  readonly type: GroupType;
  readonly enabled: boolean;
  readonly maximumPlayers: number;
  readonly capacity: {
    readonly minimumInstances: number;
    readonly maximumInstances: number;
    readonly minimumWarmInstances: number;
    readonly maximumWarmInstances: number;
  };
  readonly matchmaking: DashboardGroup["matchmaking"];
  readonly routing: DashboardGroup["routing"];
  readonly variants: readonly VariantBlueprint[];
  readonly instances: readonly InstanceBlueprint[];
  readonly queueParties: number;
  readonly detachedSessions?: readonly SessionBlueprint[];
}

const blueprints: readonly GroupBlueprint[] = [
  {
    id: "hub",
    type: "hub",
    enabled: true,
    maximumPlayers: 120,
    capacity: {
      minimumInstances: 2,
      maximumInstances: 8,
      minimumWarmInstances: 1,
      maximumWarmInstances: 3,
    },
    matchmaking: null,
    routing: { maximumPlayersPerInstance: 120, targetPlayersPerInstance: 80 },
    variants: [
      {
        id: "hub-aurora",
        weight: 100,
        image: "itzg/minecraft-server:java25",
        memoryGiB: 6,
        cpu: 4,
      },
    ],
    instances: [
      { lifecycleState: "RUNNING", availabilityState: "OPEN", load: 0.72, ageSeconds: 18_400 },
      { lifecycleState: "RUNNING", availabilityState: "OPEN", load: 0.54, ageSeconds: 12_950 },
      { lifecycleState: "RUNNING", availabilityState: "OPEN", load: 0.11, ageSeconds: 640 },
      { lifecycleState: "STARTING", availabilityState: "OPEN", load: 0, ageSeconds: 46 },
    ],
    queueParties: 0,
  },
  {
    id: "skywars-solo",
    type: "minigame",
    enabled: true,
    maximumPlayers: 12,
    capacity: {
      minimumInstances: 0,
      maximumInstances: 24,
      minimumWarmInstances: 2,
      maximumWarmInstances: 5,
    },
    matchmaking: {
      minimumPlayers: 4,
      maximumPlayers: 12,
      teamCount: 12,
      teamSize: 1,
      candidateWindow: 20,
      minimumPlayersPerTeam: 0,
      maximumTeamSpread: 1,
    },
    routing: null,
    variants: [
      {
        id: "skywars-japan",
        weight: 60,
        image: "itzg/minecraft-server:java25",
        memoryGiB: 4,
        cpu: 2,
      },
      {
        id: "skywars-nordic",
        weight: 40,
        image: "itzg/minecraft-server:java25",
        memoryGiB: 4,
        cpu: 2,
      },
      {
        id: "skywars-legacy",
        weight: 0,
        image: "itzg/minecraft-server:java21",
        memoryGiB: 3,
        cpu: 2,
        enabled: false,
      },
    ],
    instances: [
      {
        lifecycleState: "RUNNING",
        availabilityState: "RESERVED",
        load: 0.92,
        ageSeconds: 780,
        session: { state: "RUNNING", ageSeconds: 470, players: 11, connected: 11 },
      },
      {
        lifecycleState: "RUNNING",
        availabilityState: "RESERVED",
        variantIndex: 1,
        load: 0.5,
        ageSeconds: 410,
        session: {
          state: "WAITING",
          ageSeconds: 38,
          players: 8,
          connected: 6,
          deadlineKind: "LOBBY_STALE",
        },
      },
      {
        lifecycleState: "RUNNING",
        availabilityState: "RESERVED",
        load: 0.33,
        ageSeconds: 96,
        session: {
          state: "TRANSFERRING",
          ageSeconds: 21,
          players: 6,
          connected: 2,
          deadlineKind: "PLAYER_TRANSFER",
        },
      },
      { lifecycleState: "RUNNING", availabilityState: "OPEN", load: 0, ageSeconds: 1_240 },
      { lifecycleState: "RUNNING", availabilityState: "OPEN", variantIndex: 1, load: 0, ageSeconds: 900 },
      { lifecycleState: "CREATING", availabilityState: "OPEN", load: 0, ageSeconds: 12 },
      { lifecycleState: "DRAINING", availabilityState: "RESERVED", load: 0.08, ageSeconds: 2_600 },
      { lifecycleState: "FAILED", availabilityState: "OPEN", variantIndex: 1, load: 0, ageSeconds: 310 },
    ],
    queueParties: 11,
    detachedSessions: [
      {
        state: "WAITING_FOR_INSTANCE",
        ageSeconds: 26,
        players: 9,
        connected: 0,
        detached: true,
      },
    ],
  },
  {
    id: "bedwars-duo",
    type: "minigame",
    enabled: true,
    maximumPlayers: 16,
    capacity: {
      minimumInstances: 0,
      maximumInstances: 16,
      minimumWarmInstances: 2,
      maximumWarmInstances: 4,
    },
    matchmaking: {
      minimumPlayers: 8,
      maximumPlayers: 16,
      teamCount: 8,
      teamSize: 2,
      candidateWindow: 20,
      minimumPlayersPerTeam: 1,
      maximumTeamSpread: 1,
    },
    routing: null,
    variants: [
      {
        id: "bedwars-classic",
        weight: 70,
        image: "itzg/minecraft-server:java25",
        memoryGiB: 5,
        cpu: 3,
      },
      {
        id: "bedwars-rush",
        weight: 30,
        image: "itzg/minecraft-server:java25",
        memoryGiB: 5,
        cpu: 3,
      },
    ],
    instances: [
      {
        lifecycleState: "RUNNING",
        availabilityState: "RESERVED",
        load: 1,
        ageSeconds: 1_580,
        session: { state: "RUNNING", ageSeconds: 1_180, players: 16, connected: 15 },
      },
      {
        lifecycleState: "RUNNING",
        availabilityState: "RESERVED",
        variantIndex: 1,
        load: 0.75,
        ageSeconds: 620,
        session: { state: "RUNNING", ageSeconds: 300, players: 12, connected: 12 },
      },
      {
        lifecycleState: "RUNNING",
        availabilityState: "RESERVED",
        load: 0.38,
        ageSeconds: 260,
        session: {
          state: "WAITING",
          ageSeconds: 90,
          players: 10,
          connected: 6,
          deadlineKind: "LOBBY_STALE",
        },
      },
      { lifecycleState: "RUNNING", availabilityState: "OPEN", load: 0, ageSeconds: 2_100 },
      { lifecycleState: "RUNNING", availabilityState: "OPEN", variantIndex: 1, load: 0, ageSeconds: 1_700 },
      { lifecycleState: "STARTING", availabilityState: "OPEN", load: 0, ageSeconds: 31 },
      { lifecycleState: "STOPPING", availabilityState: "OPEN", load: 0, ageSeconds: 4_820 },
      {
        lifecycleState: "DRAINING",
        availabilityState: "OPEN",
        load: 0,
        ageSeconds: 15,
        drainReason: "SESSION_CANCELLED",
      },
    ],
    queueParties: 6,
  },
  {
    id: "buildbattle-party",
    type: "minigame",
    enabled: false,
    maximumPlayers: 12,
    capacity: {
      minimumInstances: 0,
      maximumInstances: 6,
      minimumWarmInstances: 0,
      maximumWarmInstances: 2,
    },
    matchmaking: {
      minimumPlayers: 4,
      maximumPlayers: 12,
      teamCount: 4,
      teamSize: 3,
      candidateWindow: 20,
      minimumPlayersPerTeam: 1,
      maximumTeamSpread: 2,
    },
    routing: null,
    variants: [
      {
        id: "buildbattle-default",
        weight: 100,
        image: "itzg/minecraft-server:java25",
        memoryGiB: 3,
        cpu: 2,
        enabled: false,
      },
    ],
    instances: [],
    queueParties: 0,
  },
];

interface MockPlayer {
  readonly playerId: string;
  readonly connectedAt: string;
  readonly lastSeenAt: string;
}

interface MockQueueEntry {
  readonly id: string;
  readonly partyId: string;
  readonly joinedAt: string;
  readonly players: readonly string[];
}

interface MockInstanceRecord {
  readonly instance: DashboardInstance;
  readonly groupId: string;
  readonly groupType: GroupType;
  readonly containerId: string | null;
  readonly runtimePath: string | null;
  readonly stoppedAt: string | null;
  readonly variant: DashboardVariant & { readonly checksum: string };
  readonly players: readonly MockPlayer[];
  readonly session: DashboardSession | null;
  readonly commands: DashboardInstanceDetail["commands"];
  readonly events: DashboardInstanceDetail["events"];
}

interface MockSessionRecord {
  readonly session: DashboardSession & { readonly groupId: string };
  readonly tickets: DashboardSessionDetail["tickets"];
  readonly expectedProfiles: DashboardSessionDetail["expectedProfiles"];
  readonly connectedProfiles: DashboardSessionDetail["connectedProfiles"];
  readonly recommendedExpectedProfile: DashboardSessionDetail["recommendedExpectedProfile"];
  readonly recommendedConnectedProfile: DashboardSessionDetail["recommendedConnectedProfile"];
  readonly transfers: DashboardSessionDetail["transfers"];
}

interface MockWorld {
  readonly generatedAt: string;
  readonly groups: readonly DashboardGroup[];
  readonly summary: DashboardClusterSnapshot["summary"];
  readonly instances: ReadonlyMap<string, MockInstanceRecord>;
  readonly sessions: ReadonlyMap<string, MockSessionRecord>;
  readonly queues: ReadonlyMap<string, readonly MockQueueEntry[]>;
}

const COMMAND_OPERATIONS = [
  "CREATE_INSTANCE",
  "START_INSTANCE",
  "REGISTER_ENDPOINT",
  "DRAIN_INSTANCE",
  "STOP_INSTANCE",
] as const;

const EVENT_TYPES = [
  "instance.created",
  "instance.started",
  "instance.ready",
  "instance.player_joined",
  "instance.player_left",
  "instance.heartbeat",
  "session.assigned",
  "session.acknowledged",
] as const;

function buildWorld(now: number): MockWorld {
  const random = mulberry32(WORLD_SEED);
  const groups: DashboardGroup[] = [];
  const instances = new Map<string, MockInstanceRecord>();
  const sessions = new Map<string, MockSessionRecord>();
  const queues = new Map<string, readonly MockQueueEntry[]>();

  for (const blueprint of blueprints) {
    const variants: DashboardVariant[] = blueprint.variants.map((variant) => ({
      id: variant.id,
      enabled: variant.enabled ?? true,
      revision: between(random, 1, 9),
      weight: variant.weight,
      runtime: {
        image: variant.image,
        memoryBytes: variant.memoryGiB * 1024 ** 3,
        cpu: variant.cpu,
        environment: {
          EULA: "TRUE",
          TYPE: "PAPER",
          MEMORY: `${variant.memoryGiB}G`,
          EC_GROUP: blueprint.id,
          EC_VARIANT: variant.id,
        },
      },
    }));

    const groupInstances: DashboardInstance[] = [];
    const groupSessions: DashboardSession[] = [];

    for (const spec of blueprint.instances) {
      const variantIndex = spec.variantIndex ?? 0;
      const variant = variants[variantIndex];
      const instanceId = internalId(random);
      const createdAt = ago(now, spec.ageSeconds);
      const started = spec.lifecycleState !== "CREATING";
      const running =
        spec.lifecycleState === "RUNNING" ||
        spec.lifecycleState === "DRAINING" ||
        spec.lifecycleState === "STOPPING";
      const draining =
        spec.lifecycleState === "DRAINING" || spec.lifecycleState === "STOPPING";
      const playerCount = Math.round((spec.load ?? 0) * blueprint.maximumPlayers);

      let session: (DashboardSession & { readonly groupId: string }) | null = null;
      if (spec.session) {
        const sessionId = internalId(random);
        session = {
          id: sessionId,
          groupId: blueprint.id,
          instanceId,
          state: spec.session.state,
          assignmentRevision: between(random, 1, 4),
          assignmentAcknowledgedAt:
            spec.session.state === "RUNNING" || spec.session.state === "STARTING"
              ? ago(now, spec.session.ageSeconds - 4)
              : null,
          instanceAcquisitionDeadline: null,
          lobbyStaleDeadline: ago(now, spec.session.ageSeconds - 135),
          retryCount: spec.session.state === "TRANSFERRING" ? 1 : 0,
          maximumPlayerCount: blueprint.maximumPlayers,
          activePlayerCount: spec.session.players,
          connectedPlayerCount: spec.session.connected,
          teamCount: blueprint.matchmaking?.teamCount ?? 0,
          createdAt: ago(now, spec.session.ageSeconds),
          startedAt:
            spec.session.state === "RUNNING"
              ? ago(now, spec.session.ageSeconds - 12)
              : null,
          finishedAt: null,
          updatedAt: ago(now, between(random, 1, 9)),
        };
        sessions.set(
          sessionId,
          buildSessionRecord(random, now, blueprint, session, spec.session),
        );
        groupSessions.push(session);
      }

      const instance: DashboardInstance = {
        id: instanceId,
        variantId: variant.id,
        sessionId: session?.id ?? null,
        lifecycleState: spec.lifecycleState,
        availabilityState: spec.availabilityState,
        endpoint: running
          ? `ec-${variant.id}-${instanceId.slice(0, 6)}:${between(random, 25_565, 25_999)}`
          : null,
        playerCount,
        maximumPlayers: blueprint.maximumPlayers,
        createdAt,
        startingAt: started ? ago(now, spec.ageSeconds - 6) : null,
        startupDeadline:
          spec.lifecycleState === "STARTING" ? ago(now, -2) : null,
        runningAt: running ? ago(now, spec.ageSeconds - 24) : null,
        renewalDeadline:
          running && blueprint.type === "hub"
            ? ago(now, spec.ageSeconds - 24 - 4 * 60 * 60)
            : null,
        replacesInstanceId: null,
        drainingAt: draining ? ago(now, Math.min(spec.ageSeconds, 180)) : null,
        drainDeadline: draining ? ago(now, -420) : null,
        drainReason: draining ? (spec.drainReason ?? "NORMAL") : null,
        stoppingAt:
          spec.lifecycleState === "STOPPING"
            ? ago(now, Math.min(spec.ageSeconds, 12))
            : null,
        shutdownDeadline:
          spec.lifecycleState === "STOPPING" ? ago(now, -8) : null,
        updatedAt: ago(now, between(random, 1, 12)),
      };

      groupInstances.push(instance);
      instances.set(
        instanceId,
        buildInstanceRecord(random, now, blueprint, instance, variant, session),
      );
    }

    for (const spec of blueprint.detachedSessions ?? []) {
      const sessionId = internalId(random);
      const session: DashboardSession & { readonly groupId: string } = {
        id: sessionId,
        groupId: blueprint.id,
        instanceId: null,
        state: spec.state,
        assignmentRevision: 0,
        assignmentAcknowledgedAt: null,
        instanceAcquisitionDeadline: ago(now, spec.ageSeconds - 45),
        lobbyStaleDeadline: null,
        retryCount: between(random, 0, 2),
        maximumPlayerCount: blueprint.maximumPlayers,
        activePlayerCount: spec.players,
        connectedPlayerCount: spec.connected,
        teamCount: blueprint.matchmaking?.teamCount ?? 0,
        createdAt: ago(now, spec.ageSeconds),
        startedAt: null,
        finishedAt: null,
        updatedAt: ago(now, between(random, 1, 5)),
      };
      sessions.set(
        sessionId,
        buildSessionRecord(random, now, blueprint, session, spec),
      );
      groupSessions.push(session);
    }

    const queueEntries = buildQueue(random, now, blueprint);
    queues.set(blueprint.id, queueEntries);

    const activeInstances = groupInstances.filter(
      (instance) =>
        instance.lifecycleState !== "STOPPED" &&
        instance.lifecycleState !== "FAILED",
    ).length;
    const warmInstances = groupInstances.filter(
      (instance) =>
        instance.lifecycleState === "RUNNING" &&
        instance.availabilityState === "OPEN",
    ).length;
    const pendingWarmInstances = groupInstances.filter(
      (instance) =>
        instance.lifecycleState === "CREATING" ||
        instance.lifecycleState === "STARTING",
    ).length;
    const reservedInstances = groupInstances.filter(
      (instance) => instance.availabilityState === "RESERVED",
    ).length;

    groups.push({
      id: blueprint.id,
      type: blueprint.type,
      enabled: blueprint.enabled,
      capacity: {
        ...blueprint.capacity,
        activeInstances,
        warmInstances,
        pendingWarmInstances,
        reservedInstances,
      },
      timeouts: {
        startupMs: 90_000,
        drainMs: 900_000,
        cancelledDrainMs: 10_000,
        shutdownMs: 20_000,
        transferMs: 20_000,
        playerStaleMs: 30_000,
        instanceLifetimeMs: blueprint.type === "hub" ? 4 * 60 * 60 * 1_000 : null,
        instanceAcquisitionMs: blueprint.type === "minigame" ? 45_000 : null,
        lobbyStaleMs: blueprint.type === "minigame" ? 135_000 : null,
      },
      matchmaking: blueprint.matchmaking,
      routing: blueprint.routing,
      queue: {
        partyCount: queueEntries.length,
        playerCount: queueEntries.reduce(
          (total, entry) => total + entry.players.length,
          0,
        ),
        oldestJoinedAt: queueEntries.at(0)?.joinedAt ?? null,
      },
      variants,
      instances: groupInstances,
      sessions: groupSessions,
    });
  }

  const summary = {
    enabledGroups: groups.filter((group) => group.enabled).length,
    activeInstances: groups.reduce(
      (total, group) => total + group.capacity.activeInstances,
      0,
    ),
    runningInstances: groups.reduce(
      (total, group) =>
        total +
        group.instances.filter((instance) => instance.lifecycleState === "RUNNING")
          .length,
      0,
    ),
    warmInstances: groups.reduce(
      (total, group) => total + group.capacity.warmInstances,
      0,
    ),
    pendingWarmInstances: groups.reduce(
      (total, group) => total + group.capacity.pendingWarmInstances,
      0,
    ),
    reservedInstances: groups.reduce(
      (total, group) => total + group.capacity.reservedInstances,
      0,
    ),
    playersOnline: groups.reduce(
      (total, group) =>
        total +
        group.instances.reduce(
          (groupTotal, instance) => groupTotal + instance.playerCount,
          0,
        ),
      0,
    ),
    activeSessions: groups.reduce(
      (total, group) =>
        total +
        group.sessions.filter(
          (session) =>
            session.state !== "FINISHED" &&
            session.state !== "CANCELLED" &&
            session.state !== "FAILED",
        ).length,
      0,
    ),
    queuedParties: groups.reduce(
      (total, group) => total + group.queue.partyCount,
      0,
    ),
    queuedPlayers: groups.reduce(
      (total, group) => total + group.queue.playerCount,
      0,
    ),
  } satisfies DashboardClusterSnapshot["summary"];

  return {
    generatedAt: new Date(now).toISOString(),
    groups,
    summary,
    instances,
    sessions,
    queues,
  };
}

function buildQueue(
  random: () => number,
  now: number,
  blueprint: GroupBlueprint,
): readonly MockQueueEntry[] {
  const entries: MockQueueEntry[] = [];
  const maximumPartySize = blueprint.matchmaking?.teamSize ?? 1;
  // Walk backwards in time so the queue is genuinely ordered oldest first, the
  // order the matchmaker consumes it in.
  let waitSeconds = 0;
  for (let index = 0; index < blueprint.queueParties; index += 1) {
    const partySize = Math.max(
      1,
      between(random, 1, Math.max(1, maximumPartySize + 1)),
    );
    const players = Array.from({ length: partySize }, () => uuid(random));
    entries.push({
      id: internalId(random),
      partyId: uuid(random),
      joinedAt: ago(now, waitSeconds),
      players,
    });
    waitSeconds += between(random, 5, 40);
  }
  return entries.reverse();
}

function buildInstanceRecord(
  random: () => number,
  now: number,
  blueprint: GroupBlueprint,
  instance: DashboardInstance,
  variant: DashboardVariant,
  session: DashboardSession | null,
): MockInstanceRecord {
  const players: MockPlayer[] = Array.from(
    { length: instance.playerCount },
    () => {
      const connectedSeconds = between(random, 20, 1_500);
      return {
        playerId: uuid(random),
        connectedAt: ago(now, connectedSeconds),
        lastSeenAt: ago(now, between(random, 0, 12)),
      };
    },
  );

  const commandCount = between(random, 2, 5);
  const commands = Array.from({ length: commandCount }, (_unused, index) => {
    const operation = COMMAND_OPERATIONS[index % COMMAND_OPERATIONS.length];
    const failed = instance.lifecycleState === "FAILED" && index === 0;
    const createdSeconds = between(random, 30, 3_000);
    return {
      id: internalId(random),
      operation,
      state: failed ? "FAILED" : "COMPLETED",
      attempts: failed ? 3 : 1,
      payload: { instanceId: instance.id, variantId: variant.id },
      lastError: failed
        ? "container exited with code 1: java.lang.OutOfMemoryError: Java heap space"
        : null,
      createdAt: ago(now, createdSeconds),
      completedAt: ago(now, Math.max(0, createdSeconds - between(random, 1, 20))),
    };
  });

  const eventCount = between(random, 4, 8);
  const events = Array.from({ length: eventCount }, () => ({
    id: internalId(random),
    type: pick(random, EVENT_TYPES),
    payload: { instanceId: instance.id, groupId: blueprint.id },
    createdAt: ago(now, between(random, 5, 2_400)),
  })).sort((left, right) => right.createdAt.localeCompare(left.createdAt));

  return {
    instance,
    groupId: blueprint.id,
    groupType: blueprint.type,
    containerId:
      instance.lifecycleState === "CREATING"
        ? null
        : `endercloud-${variant.id}-${instance.id.slice(0, 8)}`,
    runtimePath: `/data/runtime/${instance.id}`,
    stoppedAt: instance.lifecycleState === "STOPPED" ? ago(now, 60) : null,
    variant: { ...variant, checksum: uuid(random).replaceAll("-", "") },
    players,
    session,
    commands,
    events,
  };
}

function buildSessionRecord(
  random: () => number,
  now: number,
  blueprint: GroupBlueprint,
  session: DashboardSession & { readonly groupId: string },
  spec: SessionBlueprint,
): MockSessionRecord {
  const teamSize = blueprint.matchmaking?.teamSize ?? 1;
  const ticketCount = Math.max(1, Math.ceil(spec.players / teamSize));
  const tickets: {
    ticketId: string;
    partyId: string;
    transferStartedAt: string | null;
    players: {
      playerId: string;
      partyId: string;
      state: SessionPlayerState;
      selectedAt: string;
      transferringAt: string | null;
      connectedAt: string | null;
      leftAt: string | null;
    }[];
  }[] = [];

  let assigned = 0;
  let connectedBudget = spec.connected;
  for (let ticketIndex = 0; ticketIndex < ticketCount; ticketIndex += 1) {
    const players: (typeof tickets)[number]["players"] = [];
    const partyId = uuid(random);
    for (
      let slot = 0;
      slot < teamSize && assigned < spec.players;
      slot += 1, assigned += 1
    ) {
      const connected = connectedBudget > 0;
      if (connected) connectedBudget -= 1;
      const state: SessionPlayerState = connected
        ? "CONNECTED"
        : spec.state === "WAITING_FOR_INSTANCE"
          ? "SELECTED"
          : "TRANSFERRING";
      players.push({
        playerId: uuid(random),
        partyId,
        state,
        selectedAt: ago(now, spec.ageSeconds),
        transferringAt: state === "SELECTED" ? null : ago(now, spec.ageSeconds - 3),
        connectedAt: connected ? ago(now, spec.ageSeconds - 8) : null,
        leftAt: null,
      });
    }
    if (players.length > 0) {
      tickets.push({
        ticketId: internalId(random),
        partyId,
        transferStartedAt:
          spec.state === "WAITING_FOR_INSTANCE" ? null : ago(now, spec.ageSeconds - 3),
        players,
      });
    }
  }

  const transfers = session.instanceId
    ? Array.from({ length: between(random, 1, 3) }, () => {
        const createdSeconds = between(random, 5, spec.ageSeconds + 5);
        const completed =
          spec.state === "RUNNING" ||
          spec.deadlineKind === "LOBBY_STALE";
        return {
          id: internalId(random),
          instanceId: session.instanceId as string,
          state: completed ? "COMPLETED" : "PENDING",
          attempts: completed ? 1 : between(random, 1, 3),
          nextAttemptAt: ago(now, -between(random, 2, 20)),
          expiresAt: ago(now, -between(random, 20, 120)),
          createdAt: ago(now, createdSeconds),
          completedAt: completed ? ago(now, Math.max(0, createdSeconds - 4)) : null,
        };
      })
    : [];

  const configuredTeams = blueprint.matchmaking?.teamCount ?? 1;
  const expectedProfile = Array.from({ length: configuredTeams }, (_, index) =>
    tickets[index]?.players.length ?? 0
  ).sort((left, right) => left - right);
  const connectedProfile = Array.from({ length: configuredTeams }, (_, index) =>
    tickets[index]?.players.filter((player) => player.state === "CONNECTED").length ?? 0
  ).sort((left, right) => left - right);
  return {
    session,
    tickets,
    expectedProfiles: [expectedProfile],
    connectedProfiles: [connectedProfile],
    recommendedExpectedProfile: expectedProfile,
    recommendedConnectedProfile: connectedProfile,
    transfers,
  };
}

export function mockCluster(now = Date.now()): DashboardClusterSnapshot {
  const world = buildWorld(now);
  return {
    schemaVersion: 2,
    generatedAt: world.generatedAt,
    summary: world.summary,
    groups: world.groups,
  };
}

export function mockQueue(
  groupId: string,
  limit: number,
  now = Date.now(),
): DashboardQueueDetail | null {
  const world = buildWorld(now);
  const entries = world.queues.get(groupId);
  if (!entries) return null;
  return {
    schemaVersion: 2,
    generatedAt: world.generatedAt,
    groupId,
    totalParties: entries.length,
    totalPlayers: entries.reduce((total, entry) => total + entry.players.length, 0),
    truncated: entries.length > limit,
    entries: entries.slice(0, limit),
  };
}

export function mockVariantGraph(
  groupId: string,
  now = Date.now(),
): DashboardVariantGraph | null {
  const world = buildWorld(now);
  const group = world.groups.find((candidate) => candidate.id === groupId);
  if (!group) return null;

  const shared = group.type === "minigame" ? ["minecraft-paper", group.id.split("-")[0]!, group.id] : [];
  const layerIds = [...new Set([...shared, ...group.variants.map((variant) => variant.id)])];
  return {
    schemaVersion: 1,
    generatedAt: world.generatedAt,
    groupId,
    layers: layerIds.map((id, index) => {
      const runtime: VariantRuntimePatch = index === 0 || shared.length === 0
        ? {
            image: group.variants[0]!.runtime.image,
            memoryBytes: group.variants[0]!.runtime.memoryBytes,
            cpu: group.variants[0]!.runtime.cpu,
            environment: { TYPE: "CUSTOM" },
          }
        : { environment: id === group.id ? { MODE_ID: groupId } : {} };
      return {
        id,
        checksum: `${(index + 1).toString(16)}`.repeat(64).slice(0, 64),
        runtime,
        files: {
          fileCount: id === group.id ? 3 : id.includes("minecraft") ? 8 : 5,
          totalBytes: id === group.id ? 24_000 : 18_500_000,
          roots: id === group.id ? ["config"] : ["config", "plugins"],
        },
      };
    }),
    variants: group.variants.map((variant, index) => ({
      ...variant,
      checksum: `${(index + 10).toString(16)}`.repeat(64).slice(0, 64),
      layers: [...shared, variant.id],
    })),
  };
}

export function mockInstance(
  instanceId: string,
  now = Date.now(),
): DashboardInstanceDetail | null {
  const world = buildWorld(now);
  const record = world.instances.get(instanceId);
  if (!record) return null;
  return {
    schemaVersion: 2,
    generatedAt: world.generatedAt,
    activeDeadline:
      record.instance.lifecycleState === "STARTING" && record.instance.startupDeadline
        ? { kind: "INSTANCE_STARTUP", at: record.instance.startupDeadline }
        : record.instance.lifecycleState === "RUNNING" &&
            record.instance.renewalDeadline
          ? { kind: "INSTANCE_RENEWAL", at: record.instance.renewalDeadline }
        : record.instance.lifecycleState === "DRAINING" && record.instance.drainDeadline
          ? {
              kind:
                record.instance.drainReason === "SESSION_CANCELLED"
                  ? "CANCELLED_INSTANCE_DRAIN"
                  : "INSTANCE_DRAIN",
              at: record.instance.drainDeadline,
            }
          : record.instance.lifecycleState === "STOPPING" &&
              record.instance.shutdownDeadline
            ? { kind: "INSTANCE_SHUTDOWN", at: record.instance.shutdownDeadline }
            : null,
    instance: {
      ...record.instance,
      groupId: record.groupId,
      groupType: record.groupType,
      containerId: record.containerId,
      runtimePath: record.runtimePath,
      stoppedAt: record.stoppedAt,
    },
    variant: record.variant,
    players: record.players,
    session: record.session,
    commands: record.commands,
    events: record.events,
  };
}

export function mockSession(
  sessionId: string,
  now = Date.now(),
): DashboardSessionDetail | null {
  const world = buildWorld(now);
  const record = world.sessions.get(sessionId);
  if (!record) return null;
  return {
    schemaVersion: 2,
    generatedAt: world.generatedAt,
    activeDeadline:
      record.session.state === "WAITING_FOR_INSTANCE" &&
      record.session.instanceAcquisitionDeadline
        ? {
            kind: "INSTANCE_ACQUISITION",
            at: record.session.instanceAcquisitionDeadline,
          }
        : record.transfers.find((transfer) => transfer.state === "PENDING")
          ? {
              kind: "PLAYER_TRANSFER",
              at: record.transfers.find((transfer) => transfer.state === "PENDING")!
                .expiresAt,
            }
          : record.session.lobbyStaleDeadline
            ? {
                kind: "LOBBY_STALE",
                at: record.session.lobbyStaleDeadline,
              }
            : null,
    session: record.session,
    tickets: record.tickets,
    expectedProfiles: record.expectedProfiles,
    connectedProfiles: record.connectedProfiles,
    recommendedExpectedProfile: record.recommendedExpectedProfile,
    recommendedConnectedProfile: record.recommendedConnectedProfile,
    transfers: record.transfers,
  };
}
