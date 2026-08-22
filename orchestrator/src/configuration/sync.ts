import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { parse } from "yaml";
import { inArray, sql } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import {
  serverGroups,
  serverGroupVariants,
  serverVariantLayers,
  serverVariants,
  templateLayers,
} from "../db/schema.ts";
import type {
  GroupVariantReference,
  ResolvedServerVariantConfig,
  ServerGroupConfig,
  ServerVariantConfig,
  TemplateFileSummary,
  TemplateLayerSpec,
  VariantRuntimePatch,
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
export function parseGroup(
  document: unknown,
  source: string,
): ServerGroupConfig {
  const root = object(document, source);
  if (root.lifecycle !== undefined) {
    throw new Error(`${source}.lifecycle was removed; use ${source}.timeouts`);
  }
  const id = validateId(root.id, `${source}.id`);
  const type = root.type;
  if (type !== "hub" && type !== "minigame") {
    throw new Error(`${source}.type must be hub or minigame`);
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
        timeouts, "startup", source,
      ),
      drainMs: timeoutValue(
        timeouts, "drain", source,
      ),
      cancelledDrainMs: timeoutValue(
        timeouts, "cancelled_drain", source,
      ),
      shutdownMs: timeoutValue(
        timeouts, "shutdown", source,
      ),
      transferMs: timeoutValue(
        timeouts, "transfer", source,
      ),
      playerStaleMs: timeoutValue(
        timeouts, "player_stale", source,
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
      throw new Error(`${source}.timeouts.partial_start was removed; the minigame plugin controls game start`);
    }
    const teamSize = integer(
      matchmaking.team_size,
      `${source}.matchmaking.team_size`,
      1,
    );
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
    const instanceAcquisitionMs = timeoutValue(
      timeouts,
      "instance_acquisition",
      source,
    );
    const lobbyStaleMs = timeoutValue(
      timeouts,
      "lobby_stale",
      source,
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
  const instanceLifetimeMs = timeouts.instance_lifetime === undefined
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
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value !== "string") throw new Error(`${context} must be a byte count or 4G`);
  const match = /^(\d+)([KMG])$/i.exec(value);
  if (!match) throw new Error(`${context} must look like 512M or 4G`);
  const factors = { K: 1024, M: 1024 ** 2, G: 1024 ** 3 } as const;
  return Number.parseInt(match[1]!, 10) * factors[match[2]!.toUpperCase() as keyof typeof factors];
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
  let image: string | undefined;
  if (docker.image !== undefined) {
    image = string(docker.image, `${source}.docker.image`);
    const tag = image.includes("@sha256:") ? image.split("@sha256:")[1] : image.split(":").at(-1);
    if (!tag || tag === "latest") {
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
    validateId(value, `${source}.parents[${index}]`)
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

export interface InspectedTemplate {
  readonly checksum: string;
  readonly files: TemplateFileSummary;
  readonly manifest: ReadonlyMap<string, "directory" | "file">;
}

// Hash a layer and collect bounded metadata used by validation and the dashboard.
export async function inspectTemplateDirectory(root: string): Promise<InspectedTemplate> {
  const hasher = createHash("sha256");
  const manifest = new Map<string, "directory" | "file">();
  const roots = new Set<string>();
  let fileCount = 0;
  let totalBytes = 0;
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    // Filesystem enumeration order is unstable; sorting makes the checksum reproducible.
    entries.sort((a, b) => a.name.localeCompare(b.name));
    // Hash both relative paths and bytes so renames and content changes alter the revision.
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const relativePath = relative(root, path).split(sep).join("/");
      if (entry.isSymbolicLink()) {
        throw new Error(`Template symlinks are forbidden: ${path}`);
      }
      if (entry.isDirectory()) {
        manifest.set(relativePath, "directory");
        roots.add(relativePath.split("/")[0]!);
        await visit(path);
      }
      else if (entry.isFile()) {
        hasher.update(relativePath);
        hasher.update(await readFile(path));
        if (relativePath !== "variant.yml") {
          manifest.set(relativePath, "file");
          roots.add(relativePath.split("/")[0]!);
          fileCount += 1;
          totalBytes += (await stat(path)).size;
        }
      }
    }
  }
  await visit(root);
  return {
    checksum: hasher.digest("hex"),
    files: { fileCount, totalBytes, roots: [...roots].sort() },
    manifest,
  };
}

function mergeRuntime(layers: readonly TemplateLayerSpec[], context: string): VariantRuntimeSpec {
  let image: string | undefined;
  let memoryBytes: number | undefined;
  let cpu: number | undefined;
  const environment: Record<string, string> = {};
  for (const layer of layers) {
    image = layer.runtime.image ?? image;
    memoryBytes = layer.runtime.memoryBytes ?? memoryBytes;
    cpu = layer.runtime.cpu ?? cpu;
    Object.assign(environment, layer.runtime.environment);
  }
  if (!image || memoryBytes === undefined || cpu === undefined) {
    throw new Error(`${context} does not resolve a complete docker image, memory and cpu runtime`);
  }
  return { image, memoryBytes, cpu, environment };
}

function effectiveChecksum(layers: readonly TemplateLayerSpec[]): string {
  const hasher = createHash("sha256");
  for (const layer of layers) {
    hasher.update(layer.id);
    hasher.update("\0");
    hasher.update(layer.checksum);
    hasher.update("\0");
  }
  return hasher.digest("hex");
}

// Load all group and variant descriptors and verify their references.
export async function loadConfiguration(
  groupsRoot: string,
  templatesRoot: string,
) {
  const groupFiles = (await readdir(groupsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /\.ya?ml$/i.test(entry.name))
    .map((entry) => join(groupsRoot, entry.name));
  // Group files are independent, so parse them concurrently during startup.
  const groups = await Promise.all(
    groupFiles.map(async (path) =>
      parseGroup(parse(await readFile(path, "utf8")), path)
    ),
  );
  const layers: TemplateLayerSpec[] = [];
  const manifests = new Map<string, ReadonlyMap<string, "directory" | "file">>();
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
    const inspected = await inspectTemplateDirectory(templatePath);
    layers.push({
      ...variant,
      templatePath,
      checksum: inspected.checksum,
      files: inspected.files,
    });
    manifests.set(variant.id, inspected.manifest);
  }
  const layersById = new Map<string, TemplateLayerSpec>();
  for (const layer of layers) {
    if (layersById.has(layer.id)) throw new Error(`Duplicate template layer id ${layer.id}`);
    layersById.set(layer.id, layer);
  }

  const finalIds = new Set(groups.flatMap((group) => group.variants.map((variant) => variant.id)));
  const variants: ResolvedServerVariantConfig[] = [];
  for (const id of finalIds) {
    const finalLayer = layersById.get(id);
    if (!finalLayer) throw new Error(`Group references unknown final variant ${id}`);
    if (finalLayer.revision === undefined) {
      throw new Error(`Final variant ${id} must define revision`);
    }
    if (finalLayer.parents.includes(id)) throw new Error(`Final variant ${id} cannot parent itself`);
    const parents = finalLayer.parents.map((parentId) => {
      const parent = layersById.get(parentId);
      if (!parent) throw new Error(`Final variant ${id} references unknown parent ${parentId}`);
      if (parent.parents.length > 0) {
        throw new Error(`Parent layer ${parentId} cannot declare parents in flat inheritance`);
      }
      return parent;
    });
    const stack = [...parents, finalLayer];
    const observed = new Map<string, "directory" | "file">();
    for (const layer of stack) {
      for (const [path, kind] of manifests.get(layer.id) ?? []) {
        const previous = observed.get(path);
        if (previous && previous !== kind) {
          throw new Error(`Variant ${id} has a file/directory conflict at ${path}`);
        }
        observed.set(path, kind);
      }
    }
    variants.push({
      id,
      revision: finalLayer.revision,
      checksum: effectiveChecksum(stack),
      runtime: mergeRuntime(stack, `Final variant ${id}`),
      layers: stack,
    });
  }
  return { groups, layers, variants };
}

// Upsert the filesystem configuration into the database as one atomic snapshot.
export async function synchronizeConfiguration(
  db: Database,
  groupsRoot: string,
  templatesRoot: string,
  logger: Logger,
): Promise<void> {
  const configuration = await loadConfiguration(groupsRoot, templatesRoot);
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
        instanceLifetimeMs: group.timeouts.instanceLifetimeMs ?? null,
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
          instanceLifetimeMs: group.timeouts.instanceLifetimeMs ?? null,
          updatedAt: sql`now()`,
        }
      });
    }
    for (const layer of configuration.layers) {
      await tx.insert(templateLayers).values({
        id: layer.id,
        templatePath: layer.templatePath,
        checksum: layer.checksum,
        runtimePatch: layer.runtime,
        fileSummary: layer.files,
        updatedAt: sql`now()`,
      }).onConflictDoUpdate({
        target: templateLayers.id,
        set: {
          templatePath: layer.templatePath,
          checksum: layer.checksum,
          runtimePatch: layer.runtime,
          fileSummary: layer.files,
          updatedAt: sql`now()`,
        },
      });
    }

    // Effective variant metadata changes in place; existing instances keep their variant id.
    for (const variant of configuration.variants) {
      await tx.insert(serverVariants).values({
        id: variant.id,
        revision: variant.revision,
        checksum: variant.checksum,
        runtimeSpec: variant.runtime,
        updatedAt: sql`now()`,
      }).onConflictDoUpdate({
        target: serverVariants.id,
        set: {
          revision: variant.revision,
          checksum: variant.checksum,
          runtimeSpec: variant.runtime,
          updatedAt: sql`now()`,
        }
      });
    }

    const finalIds = configuration.variants.map((variant) => variant.id);
    if (finalIds.length > 0) {
      await tx.delete(serverVariantLayers).where(inArray(serverVariantLayers.variantId, finalIds));
    }
    for (const variant of configuration.variants) {
      await tx.insert(serverVariantLayers).values(
        variant.layers.map((layer, ordinal) => ({
          variantId: variant.id,
          layerId: layer.id,
          ordinal,
        })),
      );
    }

    const groupIds = configuration.groups.map((group) => group.id);
    if (groupIds.length > 0) {
      await tx.delete(serverGroupVariants).where(inArray(serverGroupVariants.groupId, groupIds));
    }
    for (const group of configuration.groups) {
      if (group.variants.length === 0) continue;
      await tx.insert(serverGroupVariants).values(
        group.variants.map((variant) => ({
          groupId: group.id,
          variantId: variant.id,
          enabled: variant.enabled,
          selectionWeight: variant.weight,
        })),
      );
    }
  });
  logger.info("configuration.synchronized", "Configuration synchronized", {
    groups: configuration.groups.length,
    layers: configuration.layers.length,
    variants: configuration.variants.length,
  });
}
