import type {
  GroupVariantReference,
  ServerGroupConfig,
  ServerVariantConfig,
  VariantRuntimePatch,
} from "@endercloud/contracts/domain";
import { z } from "zod";

const idPattern = /^[a-z0-9][a-z0-9-]{1,62}$/;

function object(value: unknown, context: string): Record<string, unknown> {
  if (!z.record(z.string(), z.unknown()).safeParse(value).success) {
    throw new Error(`${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, context: string): string {
  if (!z.string().min(1).safeParse(value).success) {
    throw new Error(`${context} must be a non-empty string`);
  }
  return value as string;
}

function integer(value: unknown, context: string, minimum = 0): number {
  if (!z.number().int().safe().min(minimum).safeParse(value).success) {
    throw new Error(`${context} must be an integer >= ${minimum}`);
  }
  return value as number;
}

function positive(value: unknown, context: string): number {
  if (!z.number().finite().positive().safeParse(value).success) {
    throw new Error(`${context} must be a positive number`);
  }
  return value as number;
}

function boolean(value: unknown, context: string, fallback?: boolean): boolean {
  if (value === undefined && fallback !== undefined) return fallback;
  if (!z.boolean().safeParse(value).success) throw new Error(`${context} must be a boolean`);
  return value as boolean;
}

// Convert human-readable duration values into milliseconds.
export function parseDuration(value: unknown, context: string): number {
  if (typeof value !== "string") {
    throw new Error(`${context} must be a duration such as 45s or 2m`);
  }
  const match = /^(\d+)(ms|s|m|h)$/.exec(value);
  if (!match) throw new Error(`${context} must be a duration such as 45s or 2m`);
  const amount = Number.parseInt(match[1]!, 10);
  if (amount <= 0) throw new Error(`${context} must be greater than zero`);
  const multipliers = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 } as const;
  const milliseconds = amount * multipliers[match[2] as keyof typeof multipliers];
  if (!Number.isSafeInteger(milliseconds) || milliseconds > 2_147_483_647)
    throw new Error(`${context} exceeds the supported duration`);
  return milliseconds;
}

function timeoutValue(
  canonical: Record<string, unknown>,
  canonicalKey: string,
  context: string,
  fallback?: number,
): number {
  const value = canonical[canonicalKey];
  if (value !== undefined) return parseDuration(value, `${context}.timeouts.${canonicalKey}`);
  if (fallback !== undefined) return fallback;
  throw new Error(`${context}.timeouts.${canonicalKey} is required`);
}

function validateId(value: unknown, context: string): string {
  const id = string(value, context);
  if (!idPattern.test(id)) {
    throw new Error(`${context} must match ${idPattern}`);
  }
  return id;
}

// Validate a group descriptor and enforce cross-field capacity constraints.
export function parseGroup(document: unknown, source: string): ServerGroupConfig {
  const root = object(document, source);
  if (root.lifecycle !== undefined) {
    throw new Error(`${source}.lifecycle was removed; use ${source}.timeouts`);
  }
  const id = validateId(root.id, `${source}.id`);
  const type = root.type;
  if (type !== "hub" && type !== "minigame" && type !== "proxy") {
    throw new Error(`${source}.type must be hub, minigame or proxy`);
  }
  if (!Array.isArray(root.variants)) {
    throw new Error(`${source}.variants must be an array`);
  }
  const variants: GroupVariantReference[] = root.variants.map((value, index) => {
    const item = object(value, `${source}.variants[${index}]`);
    return {
      id: validateId(item.id, `${source}.variants[${index}].id`),
      enabled: boolean(item.enabled, `${source}.variants[${index}].enabled`, true),
      weight: integer(item.weight, `${source}.variants[${index}].weight`, 1),
    };
  });
  if (new Set(variants.map((variant) => variant.id)).size !== variants.length) {
    throw new Error(`${source}.variants contains duplicate ids`);
  }
  const groupEnabled = boolean(root.enabled, `${source}.enabled`, true);
  if (groupEnabled && !variants.some((variant) => variant.enabled)) {
    throw new Error(`${source}.variants must contain at least one enabled variant`);
  }
  const capacity = object(root.capacity, `${source}.capacity`);
  const timeouts = object(root.timeouts ?? {}, `${source}.timeouts`);
  const parsed: ServerGroupConfig = {
    id,
    type,
    enabled: groupEnabled,
    variants,
    capacity: {
      minimumInstances: integer(capacity.minimum_instances, `${source}.capacity.minimum_instances`),
      maximumInstances: integer(
        capacity.maximum_instances,
        `${source}.capacity.maximum_instances`,
        1,
      ),
      minimumWarmInstances: integer(
        type === "proxy" ? capacity.minimum_instances : capacity.minimum_warm_instances,
        `${source}.capacity.minimum_warm_instances`,
      ),
      maximumWarmInstances: integer(
        type === "proxy" ? capacity.maximum_instances : capacity.maximum_warm_instances,
        `${source}.capacity.maximum_warm_instances`,
      ),
    },
    timeouts: {
      startupMs: timeoutValue(timeouts, "startup", source),
      drainMs: timeoutValue(timeouts, "drain", source),
      cancelledDrainMs: timeoutValue(
        timeouts,
        "cancelled_drain",
        source,
        type === "proxy" ? 10_000 : undefined,
      ),
      shutdownMs: timeoutValue(timeouts, "shutdown", source),
      transferMs: timeoutValue(timeouts, "transfer", source, type === "proxy" ? 20_000 : undefined),
      playerStaleMs: timeoutValue(timeouts, "player_stale", source),
    },
  };
  if (
    parsed.capacity.minimumInstances > parsed.capacity.maximumInstances ||
    parsed.capacity.minimumWarmInstances > parsed.capacity.maximumWarmInstances ||
    parsed.capacity.maximumWarmInstances > parsed.capacity.maximumInstances
  ) {
    throw new Error(`${source} has inconsistent capacity limits`);
  }

  if (type === "proxy") {
    if (parsed.capacity.minimumInstances !== parsed.capacity.maximumInstances) {
      throw new Error(`${source} proxy minimum_instances must equal maximum_instances`);
    }
    if (
      root.routing !== undefined ||
      root.matchmaking !== undefined ||
      timeouts.instance_lifetime !== undefined
    ) {
      throw new Error(
        `${source} proxy groups cannot configure routing, matchmaking or instance_lifetime`,
      );
    }
    return parsed;
  }

  if (type === "minigame") {
    if (timeouts.instance_lifetime !== undefined) {
      throw new Error(`${source}.timeouts.instance_lifetime is only valid for hub groups`);
    }
    const matchmaking = object(root.matchmaking, `${source}.matchmaking`);
    const removedMatchmakingKeys = {
      waiting_timeout: "timeouts.instance_acquisition and timeouts.lobby_stale",
      instance_wait_timeout: "timeouts.instance_acquisition",
      maximum_waiting_timeout: "timeouts.lobby_stale",
      partial_start: "matchmaking.team_balance",
    } as const;
    for (const [key, replacement] of Object.entries(removedMatchmakingKeys)) {
      if (matchmaking[key] !== undefined) {
        throw new Error(`${source}.matchmaking.${key} was removed; use ${replacement}`);
      }
    }
    if (timeouts.ineligible_lobby !== undefined) {
      throw new Error(`${source}.timeouts.ineligible_lobby was removed; use timeouts.lobby_stale`);
    }
    if (timeouts.partial_start !== undefined) {
      throw new Error(
        `${source}.timeouts.partial_start was removed; the minigame plugin controls game start`,
      );
    }
    const teamSize = integer(matchmaking.team_size, `${source}.matchmaking.team_size`, 1);
    const teamBalance = object(
      matchmaking.team_balance ?? {},
      `${source}.matchmaking.team_balance`,
    );
    const policy = {
      minimumPlayers: integer(
        matchmaking.minimum_players,
        `${source}.matchmaking.minimum_players`,
        1,
      ),
      maximumPlayers: integer(
        matchmaking.maximum_players,
        `${source}.matchmaking.maximum_players`,
        1,
      ),
      teamCount: integer(matchmaking.team_count, `${source}.matchmaking.team_count`, 1),
      teamSize,
      candidateWindow: integer(
        matchmaking.candidate_window ?? 20,
        `${source}.matchmaking.candidate_window`,
        1,
      ),
      minimumPlayersPerTeam: integer(
        teamBalance.minimum_players_per_team ?? 0,
        `${source}.matchmaking.team_balance.minimum_players_per_team`,
      ),
      maximumTeamSpread: integer(
        teamBalance.maximum_team_spread ?? teamSize,
        `${source}.matchmaking.team_balance.maximum_team_spread`,
      ),
    };
    if (
      policy.minimumPlayers > policy.maximumPlayers ||
      policy.maximumPlayers > policy.teamCount * policy.teamSize ||
      policy.minimumPlayersPerTeam > policy.teamSize ||
      policy.maximumTeamSpread > policy.teamSize
    ) {
      throw new Error(`${source} has inconsistent matchmaking limits`);
    }
    const instanceAcquisitionMs = timeoutValue(timeouts, "instance_acquisition", source);
    const lobbyStaleMs = timeoutValue(timeouts, "lobby_stale", source);
    return {
      ...parsed,
      timeouts: {
        ...parsed.timeouts,
        instanceAcquisitionMs,
        lobbyStaleMs,
      },
      matchmaking: policy,
    };
  }

  const routing = object(root.routing, `${source}.routing`);
  const maximumPlayersPerInstance = integer(
    routing.maximum_players_per_instance,
    `${source}.routing.maximum_players_per_instance`,
    1,
  );
  const targetPlayersPerInstance = integer(
    routing.target_players_per_instance,
    `${source}.routing.target_players_per_instance`,
    1,
  );
  if (targetPlayersPerInstance > maximumPlayersPerInstance) {
    throw new Error(`${source} target routing capacity exceeds its maximum`);
  }
  const instanceLifetimeMs =
    timeouts.instance_lifetime === undefined
      ? 4 * 60 * 60 * 1_000
      : parseDuration(timeouts.instance_lifetime, `${source}.timeouts.instance_lifetime`);
  return {
    ...parsed,
    timeouts: {
      ...parsed.timeouts,
      instanceLifetimeMs,
    },
    routing: { maximumPlayersPerInstance, targetPlayersPerInstance },
  };
}

function parseMemory(value: unknown, context: string): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value !== "string") throw new Error(`${context} must be a byte count or 4G`);
  const match = /^(\d+)([KMG])$/i.exec(value);
  if (!match) throw new Error(`${context} must look like 512M or 4G`);
  const factors = { K: 1024, M: 1024 ** 2, G: 1024 ** 3 } as const;
  const bytes =
    Number.parseInt(match[1]!, 10) * factors[match[2]!.toUpperCase() as keyof typeof factors];
  if (!Number.isSafeInteger(bytes) || bytes <= 0)
    throw new Error(`${context} exceeds the supported memory bound`);
  return bytes;
}

// Validate one reusable template layer. Whether it is instantiable is decided by groups.
export function parseVariant(document: unknown, source: string): ServerVariantConfig {
  const root = object(document, source);
  for (const removed of ["group", "enabled", "weight"] as const) {
    if (root[removed] !== undefined) {
      throw new Error(`${source}.${removed} is no longer valid; configure it in the group`);
    }
  }
  const docker = object(root.docker ?? {}, `${source}.docker`);
  let dataDirectory: string | undefined;
  if (docker.data_directory !== undefined) {
    dataDirectory = string(docker.data_directory, `${source}.docker.data_directory`);
    if (!/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/.test(dataDirectory)) {
      throw new Error(`${source}.docker.data_directory must be an absolute container directory`);
    }
  }
  let image: string | undefined;
  if (docker.image !== undefined) {
    image = string(docker.image, `${source}.docker.image`);
    const digest = /^[^\s@]+@sha256:[a-f0-9]{64}$/.test(image);
    const colon = image.lastIndexOf(":");
    const tag = colon > image.lastIndexOf("/") ? image.slice(colon + 1) : undefined;
    if (
      /\s|\\|:\/\//.test(image) ||
      (!digest &&
        (!tag ||
          tag === "latest" ||
          !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(tag) ||
          image.includes("@")))
    ) {
      throw new Error(`${source}.docker.image must use an explicit tag or digest`);
    }
  }
  const rawEnvironment = object(root.environment ?? {}, `${source}.environment`);
  const environment: Record<string, string> = {};
  // Docker expects strings, so accept YAML scalars and normalize them here.
  for (const [key, value] of Object.entries(rawEnvironment)) {
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      throw new Error(`${source}.environment.${key} must be scalar`);
    }
    environment[key] = String(value);
  }
  const runtime: VariantRuntimePatch = {
    ...(dataDirectory ? { dataDirectory } : {}),
    ...(image ? { image } : {}),
    ...(docker.memory !== undefined
      ? { memoryBytes: parseMemory(docker.memory, `${source}.docker.memory`) }
      : {}),
    ...(docker.cpu !== undefined ? { cpu: positive(docker.cpu, `${source}.docker.cpu`) } : {}),
    environment,
  };
  if (root.parents !== undefined && !Array.isArray(root.parents)) {
    throw new Error(`${source}.parents must be an array`);
  }
  const parents = (root.parents ?? []).map((value: unknown, index: number) =>
    validateId(value, `${source}.parents[${index}]`),
  );
  if (new Set(parents).size !== parents.length) {
    throw new Error(`${source}.parents contains duplicate ids`);
  }
  return {
    id: validateId(root.id, `${source}.id`),
    ...(root.revision === undefined
      ? {}
      : { revision: integer(root.revision, `${source}.revision`, 1) }),
    parents,
    runtime,
  };
}
