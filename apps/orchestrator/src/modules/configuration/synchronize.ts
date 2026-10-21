import type { Logger } from "@endercloud/runtime/logger";
import { and,eq,inArray,notInArray,sql } from "drizzle-orm";
import type { Database } from "../../db/client.ts";
import {
serverGroups,
serverGroupVariants,
serverVariantLayers,
serverVariants,
templateLayers,
} from "../../db/schema.ts";



import { loadConfiguration } from "./load.ts";

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
    const groupIds = configuration.groups.map((group) => group.id);
    await tx.update(serverGroups)
      .set({ enabled: false, updatedAt: sql`now()` })
      .where(and(
        eq(serverGroups.enabled, true),
        groupIds.length > 0 ? notInArray(serverGroups.id, groupIds) : undefined,
      ));

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
