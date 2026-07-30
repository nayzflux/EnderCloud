import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { parse } from "yaml";
import { sql } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { serverGroups, serverVariants } from "../db/schema.ts";
import type {
  ServerGroupConfig,
  ServerVariantConfig,
  VariantRuntimeSpec,
} from "../domain/types.ts";
import type { Logger } from "../logger.ts";

const idPattern = /^[a-z0-9][a-z0-9-]{1,62}$/;

function object(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, context: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${context} must be a non-empty string`);
  }
  return value;
}

function integer(value: unknown, context: string, minimum = 0): number {
  if (!Number.isInteger(value) || (value as number) < minimum) {
    throw new Error(`${context} must be an integer >= ${minimum}`);
  }
  return value as number;
}

function positive(value: unknown, context: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${context} must be a positive number`);
  }
  return value;
}

function boolean(value: unknown, context: string, fallback?: boolean): boolean {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${context} must be a boolean`);
  return value;
}

// Convert human-readable duration values into milliseconds.
export function parseDuration(value: unknown, context: string): number {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value !== "string") {
    throw new Error(`${context} must be a duration such as 45s or 2m`);
  }
  const match = /^(\d+)(ms|s|m|h)$/.exec(value);
  if (!match) throw new Error(`${context} must be a duration such as 45s or 2m`);
  const amount = Number.parseInt(match[1]!, 10);
  if (amount <= 0) throw new Error(`${context} must be greater than zero`);
  const multipliers = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 } as const;
  return amount * multipliers[match[2] as keyof typeof multipliers];
}

export interface GroupTimeoutFallbacks {
  readonly transferMs: number;
  readonly cancelledDrainMs: number;
  readonly playerStaleMs?: number;
  readonly warn?: (message: string) => void;
}

function timeoutValue(
  canonical: Record<string, unknown>,
  canonicalKey: string,
  legacy: Record<string, unknown>,
  legacyKey: string,
  context: string,
  fallback?: number,
  warn?: (message: string) => void,
): number {
  const next = canonical[canonicalKey];
  const previous = legacy[legacyKey];
  if (next !== undefined && previous !== undefined) {
    throw new Error(
      `${context} cannot define both timeouts.${canonicalKey} and deprecated ${legacyKey}`,
    );
  }
  if (next !== undefined) return parseDuration(next, `${context}.timeouts.${canonicalKey}`);
  if (previous !== undefined) {
    warn?.(`${context}.${legacyKey} is deprecated; use timeouts.${canonicalKey}`);
    return parseDuration(previous, `${context}.${legacyKey}`);
  }
  if (fallback !== undefined) return fallback;
  throw new Error(`${context}.timeouts.${canonicalKey} is required`);
}

function renamedTimeoutValue(
  canonical: Record<string, unknown>,
  canonicalKey: string,
  aliases: readonly {
    readonly container: Record<string, unknown>;
    readonly key: string;
    readonly path: string;
  }[],
  context: string,
  fallback?: number,
  warn?: (message: string) => void,
): number {
  const candidates = [
    {
      value: canonical[canonicalKey],
      path: `${context}.timeouts.${canonicalKey}`,
      deprecated: false,
    },
    ...aliases.map((alias) => ({
      value: alias.container[alias.key],
      path: `${context}.${alias.path}`,
      deprecated: true,
    })),
  ].filter((candidate) => candidate.value !== undefined);
  if (candidates.length > 1) {
    throw new Error(
      `${context} defines duplicate timeout names: ${candidates.map((item) => item.path).join(", ")}`,
    );
  }
  const selected = candidates[0];
  if (selected) {
    if (selected.deprecated) {
      warn?.(`${selected.path} is deprecated; use timeouts.${canonicalKey}`);
    }
    return parseDuration(selected.value, selected.path);
  }
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
export function parseGroup(
  document: unknown,
  source: string,
  timeoutFallbacks: GroupTimeoutFallbacks = {
    transferMs: 20_000,
    cancelledDrainMs: 10_000,
    playerStaleMs: 30_000,
  },
): ServerGroupConfig {
  const root = object(document, source);
  const id = validateId(root.id, `${source}.id`);
  const type = root.type;
  if (type !== "hub" && type !== "minigame") {
    throw new Error(`${source}.type must be hub or minigame`);
  }
  const capacity = object(root.capacity, `${source}.capacity`);
  const timeouts = object(root.timeouts ?? {}, `${source}.timeouts`);
  const lifecycle = object(root.lifecycle ?? {}, `${source}.lifecycle`);
  const parsed: ServerGroupConfig = {
    id,
    type,
    enabled: boolean(root.enabled, `${source}.enabled`, true),
    capacity: {
      minimumInstances: integer(
        capacity.minimum_instances,
        `${source}.capacity.minimum_instances`,
      ),
      maximumInstances: integer(
        capacity.maximum_instances,
        `${source}.capacity.maximum_instances`,
        1,
      ),
      minimumWarmInstances: integer(
        capacity.minimum_warm_instances,
        `${source}.capacity.minimum_warm_instances`,
      ),
      maximumWarmInstances: integer(
        capacity.maximum_warm_instances,
        `${source}.capacity.maximum_warm_instances`,
      ),
    },
    timeouts: {
      startupMs: timeoutValue(
        timeouts, "startup", lifecycle, "startup_timeout", source, undefined, timeoutFallbacks.warn,
      ),
      drainMs: timeoutValue(
        timeouts, "drain", lifecycle, "draining_timeout", source, undefined, timeoutFallbacks.warn,
      ),
      cancelledDrainMs: timeoutValue(
        timeouts, "cancelled_drain", {}, "cancelled_drain_timeout", source,
        timeoutFallbacks.cancelledDrainMs, timeoutFallbacks.warn,
      ),
      shutdownMs: timeoutValue(
        timeouts, "shutdown", lifecycle, "shutdown_timeout", source, undefined,
        timeoutFallbacks.warn,
      ),
      transferMs: timeoutValue(
        timeouts, "transfer", {}, "transfer_timeout", source,
        timeoutFallbacks.transferMs, timeoutFallbacks.warn,
      ),
      playerStaleMs: timeoutValue(
        timeouts, "player_stale", {}, "player_stale_timeout", source,
        timeoutFallbacks.playerStaleMs ?? 30_000, timeoutFallbacks.warn,
      ),
    },
  };
  if (
    parsed.capacity.minimumInstances > parsed.capacity.maximumInstances ||
    parsed.capacity.minimumWarmInstances > parsed.capacity.maximumWarmInstances ||
    parsed.capacity.maximumWarmInstances > parsed.capacity.maximumInstances
  ) {
    throw new Error(`${source} has inconsistent capacity limits`);
  }

  if (type === "minigame") {
    const matchmaking = object(root.matchmaking, `${source}.matchmaking`);
    const legacyWaitingMs = matchmaking.waiting_timeout === undefined
      ? undefined
      : parseDuration(matchmaking.waiting_timeout, `${source}.matchmaking.waiting_timeout`);
    if (matchmaking.waiting_timeout !== undefined) {
      timeoutFallbacks.warn?.(
        `${source}.matchmaking.waiting_timeout is deprecated and no longer controls game start`,
      );
    }
    if (timeouts.partial_start !== undefined) {
      timeoutFallbacks.warn?.(
        `${source}.timeouts.partial_start is deprecated and ignored; the minigame plugin controls game start`,
      );
    }
    const teamSize = integer(
      matchmaking.team_size,
      `${source}.matchmaking.team_size`,
      1,
    );
    if (matchmaking.team_balance !== undefined && matchmaking.partial_start !== undefined) {
      throw new Error(
        `${source} cannot define both matchmaking.team_balance and deprecated matchmaking.partial_start`,
      );
    }
    if (matchmaking.partial_start !== undefined) {
      timeoutFallbacks.warn?.(
        `${source}.matchmaking.partial_start is deprecated; use matchmaking.team_balance`,
      );
    }
    const teamBalance = object(
      matchmaking.team_balance ?? matchmaking.partial_start ?? {},
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
    const instanceAcquisitionMs = timeoutValue(
      timeouts,
      "instance_acquisition",
      matchmaking,
      "instance_wait_timeout",
      source,
      legacyWaitingMs,
      timeoutFallbacks.warn,
    );
    const lobbyStaleMs = renamedTimeoutValue(
      timeouts,
      "lobby_stale",
      [
        {
          container: timeouts,
          key: "ineligible_lobby",
          path: "timeouts.ineligible_lobby",
        },
        {
          container: matchmaking,
          key: "maximum_waiting_timeout",
          path: "matchmaking.maximum_waiting_timeout",
        },
      ],
      source,
      legacyWaitingMs === undefined ? undefined : legacyWaitingMs * 3,
      timeoutFallbacks.warn,
    );
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
  return {
    ...parsed,
    routing: { maximumPlayersPerInstance, targetPlayersPerInstance },
  };
}

function parseMemory(value: unknown, context: string): number {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value !== "string") throw new Error(`${context} must be a byte count or 4G`);
  const match = /^(\d+)([KMG])$/i.exec(value);
  if (!match) throw new Error(`${context} must look like 512M or 4G`);
  const factors = { K: 1024, M: 1024 ** 2, G: 1024 ** 3 } as const;
  return Number.parseInt(match[1]!, 10) * factors[match[2]!.toUpperCase() as keyof typeof factors];
}

// Validate a variant descriptor and normalize its Docker runtime specification.
export function parseVariant(document: unknown, source: string): ServerVariantConfig {
  const root = object(document, source);
  const docker = object(root.docker, `${source}.docker`);
  const image = string(docker.image, `${source}.docker.image`);
  const tag = image.includes("@sha256:") ? image.split("@sha256:")[1] : image.split(":").at(-1);
  if (!tag || tag === "latest") {
    throw new Error(`${source}.docker.image must use an explicit tag or digest`);
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
  const runtime: VariantRuntimeSpec = {
    image,
    memoryBytes: parseMemory(docker.memory, `${source}.docker.memory`),
    cpu: positive(docker.cpu, `${source}.docker.cpu`),
    environment,
  };
  return {
    id: validateId(root.id, `${source}.id`),
    group: validateId(root.group, `${source}.group`),
    enabled: boolean(root.enabled, `${source}.enabled`, true),
    revision: integer(root.revision, `${source}.revision`, 1),
    weight: integer(root.weight, `${source}.weight`, 1),
    runtime,
  };
}

// Produce a deterministic checksum so template revisions can be tracked reliably.
async function checksumDirectory(root: string): Promise<string> {
  const hasher = createHash("sha256");
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    // Filesystem enumeration order is unstable; sorting makes the checksum reproducible.
    entries.sort((a, b) => a.name.localeCompare(b.name));
    // Hash both relative paths and bytes so renames and content changes alter the revision.
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Template symlinks are forbidden: ${path}`);
      }
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        hasher.update(relative(root, path).split(sep).join("/"));
        hasher.update(await readFile(path));
      }
    }
  }
  await visit(root);
  return hasher.digest("hex");
}

// Load all group and variant descriptors and verify their references.
export async function loadConfiguration(
  groupsRoot: string,
  templatesRoot: string,
  timeoutFallbacks?: GroupTimeoutFallbacks,
) {
  const groupFiles = (await readdir(groupsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /\.ya?ml$/i.test(entry.name))
    .map((entry) => join(groupsRoot, entry.name));
  // Group files are independent, so parse them concurrently during startup.
  const groups = await Promise.all(
    groupFiles.map(async (path) =>
      parseGroup(parse(await readFile(path, "utf8")), path, timeoutFallbacks)
    ),
  );
  const variants: Array<ServerVariantConfig & { templatePath: string; checksum: string }> = [];
  // Each template directory is optional until it contains a valid variant.yml descriptor.
  for (const entry of await readdir(templatesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const templatePath = resolve(templatesRoot, entry.name);
    const descriptor = join(templatePath, "variant.yml");
    try {
      const descriptorStat = await stat(descriptor);
      if (!descriptorStat.isFile()) continue;
    } catch {
      continue;
    }
    const variant = parseVariant(parse(await readFile(descriptor, "utf8")), descriptor);
    variants.push({ ...variant, templatePath, checksum: await checksumDirectory(templatePath) });
  }
  const groupIds = new Set(groups.map((group) => group.id));
  // Reject dangling variant references before writing any configuration to the database.
  for (const variant of variants) {
    if (!groupIds.has(variant.group)) {
      throw new Error(`Variant ${variant.id} references unknown group ${variant.group}`);
    }
  }
  return { groups, variants };
}

// Upsert the filesystem configuration into the database as one atomic snapshot.
export async function synchronizeConfiguration(
  db: Database,
  groupsRoot: string,
  templatesRoot: string,
  logger: Logger,
  timeoutFallbacks?: Omit<GroupTimeoutFallbacks, "warn">,
): Promise<void> {
  const configuration = await loadConfiguration(groupsRoot, templatesRoot, {
    transferMs: timeoutFallbacks?.transferMs ?? 20_000,
    cancelledDrainMs: timeoutFallbacks?.cancelledDrainMs ?? 10_000,
    playerStaleMs: timeoutFallbacks?.playerStaleMs ?? 30_000,
    warn: (message) => logger.warn("Deprecated group timeout configuration", { message }),
  });
  // Groups and variants are committed together so readers never observe a partial config refresh.
  await db.transaction(async (tx) => {
    // Upsert preserves runtime rows that reference stable group identifiers.
    for (const group of configuration.groups) {
      const matchmaking = group.matchmaking;
      const routing = group.routing;
      await tx.insert(serverGroups).values({
        id: group.id,
        type: group.type,
        enabled: group.enabled,
        minimumPlayers: matchmaking?.minimumPlayers ?? null,
        maximumPlayers: matchmaking?.maximumPlayers ?? null,
        teamCount: matchmaking?.teamCount ?? null,
        teamSize: matchmaking?.teamSize ?? null,
        candidateWindow: matchmaking?.candidateWindow ?? null,
        instanceAcquisitionTimeoutMs: group.timeouts.instanceAcquisitionMs ?? null,
        lobbyStaleTimeoutMs: group.timeouts.lobbyStaleMs ?? null,
        minimumPlayersPerTeam: matchmaking?.minimumPlayersPerTeam ?? null,
        maximumTeamSpread: matchmaking?.maximumTeamSpread ?? null,
        minimumInstances: group.capacity.minimumInstances,
        maximumInstances: group.capacity.maximumInstances,
        minimumWarmInstances: group.capacity.minimumWarmInstances,
        maximumWarmInstances: group.capacity.maximumWarmInstances,
        maximumPlayersPerInstance: routing?.maximumPlayersPerInstance ?? null,
        targetPlayersPerInstance: routing?.targetPlayersPerInstance ?? null,
        startupTimeoutMs: group.timeouts.startupMs,
        drainTimeoutMs: group.timeouts.drainMs,
        cancelledDrainTimeoutMs: group.timeouts.cancelledDrainMs,
        shutdownTimeoutMs: group.timeouts.shutdownMs,
        transferTimeoutMs: group.timeouts.transferMs,
        playerStaleTimeoutMs: group.timeouts.playerStaleMs,
        updatedAt: sql`now()`,
      }).onConflictDoUpdate({
        target: serverGroups.id,
        set: {
          type: group.type,
          enabled: group.enabled,
          minimumPlayers: matchmaking?.minimumPlayers ?? null,
          maximumPlayers: matchmaking?.maximumPlayers ?? null,
          teamCount: matchmaking?.teamCount ?? null,
          teamSize: matchmaking?.teamSize ?? null,
          candidateWindow: matchmaking?.candidateWindow ?? null,
          instanceAcquisitionTimeoutMs: group.timeouts.instanceAcquisitionMs ?? null,
          lobbyStaleTimeoutMs: group.timeouts.lobbyStaleMs ?? null,
          minimumPlayersPerTeam: matchmaking?.minimumPlayersPerTeam ?? null,
          maximumTeamSpread: matchmaking?.maximumTeamSpread ?? null,
          minimumInstances: group.capacity.minimumInstances,
          maximumInstances: group.capacity.maximumInstances,
          minimumWarmInstances: group.capacity.minimumWarmInstances,
          maximumWarmInstances: group.capacity.maximumWarmInstances,
          maximumPlayersPerInstance: routing?.maximumPlayersPerInstance ?? null,
          targetPlayersPerInstance: routing?.targetPlayersPerInstance ?? null,
          startupTimeoutMs: group.timeouts.startupMs,
          drainTimeoutMs: group.timeouts.drainMs,
          cancelledDrainTimeoutMs: group.timeouts.cancelledDrainMs,
          shutdownTimeoutMs: group.timeouts.shutdownMs,
          transferTimeoutMs: group.timeouts.transferMs,
          playerStaleTimeoutMs: group.timeouts.playerStaleMs,
          updatedAt: sql`now()`,
        }
      });
    }
    // Variant metadata changes in place; existing instances keep their selected variant id.
    for (const variant of configuration.variants) {
      await tx.insert(serverVariants).values({
        id: variant.id,
        groupId: variant.group,
        templatePath: variant.templatePath,
        enabled: variant.enabled,
        revision: variant.revision,
        selectionWeight: variant.weight,
        checksum: variant.checksum,
        runtimeSpec: variant.runtime,
        updatedAt: sql`now()`,
      }).onConflictDoUpdate({
        target: serverVariants.id,
        set: {
          groupId: variant.group,
          templatePath: variant.templatePath,
          enabled: variant.enabled,
          revision: variant.revision,
          selectionWeight: variant.weight,
          checksum: variant.checksum,
          runtimeSpec: variant.runtime,
          updatedAt: sql`now()`,
        }
      });
    }
  });
  logger.info("Configuration synchronized", {
    groups: configuration.groups.length,
    variants: configuration.variants.length,
  });
}
