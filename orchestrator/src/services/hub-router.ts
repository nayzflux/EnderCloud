import { and, eq, gt, inArray, isNotNull, ne, sql } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import {
  instancePlayers,
  executionHosts,
  serverGroups,
  serverInstances,
  transferCommands,
} from "../db/schema.ts";
import type { TransferService } from "./transfer-service.ts";
import { allocateHubPlayers } from "../domain/hub-routing.ts";

export interface HubTransferResult {
  readonly acceptedPlayers: readonly string[];
  readonly rejectedPlayers: readonly string[];
}

interface HubTarget {
  readonly id: string;
  readonly endpoint: string;
  readonly maximumPlayers: number;
  readonly effectiveLoad: number;
}

interface PendingTransferPayload {
  readonly players?: readonly string[];
}

export class HubRouter {
  public constructor(
    private readonly db: Database,
    private readonly transfers: TransferService,
  ) {}

  public async transferConnectedPlayers(
    sourceInstanceId: string,
    reason?: "SESSION_CANCELLED",
  ): Promise<HubTransferResult> {
    const players = await this.db
      .select({ playerId: instancePlayers.playerId })
      .from(instancePlayers)
      .where(eq(instancePlayers.instanceId, sourceInstanceId));
    return this.transferPlayers(
      sourceInstanceId,
      players.map((player) => player.playerId),
      reason,
    );
  }

  public async transferPlayers(
    sourceInstanceId: string,
    requestedPlayerIds: readonly string[],
    reason?: "SESSION_CANCELLED",
  ): Promise<HubTransferResult> {
    const playerIds = [...new Set(requestedPlayerIds)];
    if (playerIds.length === 0) {
      return { acceptedPlayers: [], rejectedPlayers: [] };
    }

    return this.db.transaction(async (tx: any) => {
      // Serialize every hub-routing decision so concurrent calls cannot consume
      // the same advertised capacity.
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(hashtext('endercloud:hub-routing'))
      `);

      const connected = await tx
        .select({ playerId: instancePlayers.playerId })
        .from(instancePlayers)
        .where(
          and(
            eq(instancePlayers.instanceId, sourceInstanceId),
            inArray(instancePlayers.playerId, playerIds),
          ),
        );
      const connectedIds = new Set<string>(
        connected.map((player: { playerId: string }) => player.playerId),
      );
      if (connectedIds.size === 0) {
        return { acceptedPlayers: [], rejectedPlayers: playerIds };
      }

      const alreadyOnHub = await tx
        .select({ playerId: instancePlayers.playerId })
        .from(instancePlayers)
        .innerJoin(
          serverInstances,
          eq(serverInstances.id, instancePlayers.instanceId),
        )
        .innerJoin(serverGroups, eq(serverGroups.id, serverInstances.groupId))
        .innerJoin(executionHosts, eq(executionHosts.id, serverInstances.hostId))
        .where(
          and(
            inArray(instancePlayers.playerId, [...connectedIds]),
            eq(serverGroups.type, "hub"),
            eq(serverGroups.enabled, true),
            eq(serverInstances.lifecycleState, "RUNNING"),
            eq(serverInstances.availabilityState, "OPEN"),
            eq(executionHosts.healthState, "ONLINE"),
            eq(executionHosts.adminState, "ACTIVE"),
          ),
        );
      const acceptedIds = new Set<string>(
        alreadyOnHub.map((player: { playerId: string }) => player.playerId),
      );

      // A repeated request for a player who already has a durable hub transfer
      // is successful without creating a competing command.
      const pendingHubTransfers = await tx
        .select({ payload: transferCommands.payload })
        .from(transferCommands)
        .innerJoin(
          serverInstances,
          eq(serverInstances.id, transferCommands.instanceId),
        )
        .innerJoin(serverGroups, eq(serverGroups.id, serverInstances.groupId))
        .innerJoin(executionHosts, eq(executionHosts.id, serverInstances.hostId))
        .where(
          and(
            eq(transferCommands.state, "PENDING"),
            gt(transferCommands.expiresAt, sql`now()`),
            eq(serverGroups.type, "hub"),
            eq(serverGroups.enabled, true),
            eq(serverInstances.lifecycleState, "RUNNING"),
            eq(serverInstances.availabilityState, "OPEN"),
            eq(executionHosts.healthState, "ONLINE"),
            eq(executionHosts.adminState, "ACTIVE"),
          ),
        ) as { payload: PendingTransferPayload }[];
      for (const pending of pendingHubTransfers) {
        for (const playerId of pending.payload.players ?? []) {
          if (connectedIds.has(playerId)) acceptedIds.add(playerId);
        }
      }

      const targets = (await tx
        .select({
          id: serverInstances.id,
          endpoint: serverInstances.endpoint,
          playerCount: serverInstances.playerCount,
          maximumPlayers: serverGroups.maximumPlayersPerInstance,
          pendingPlayers: sql<number>`COALESCE((
            SELECT sum(jsonb_array_length(pending.payload->'players'))::int
            FROM transfer_commands pending
            WHERE pending.instance_id = ${serverInstances.id}
              AND pending.state = 'PENDING'
              AND pending.expires_at > now()
          ), 0)::int`,
        })
        .from(serverInstances)
        .innerJoin(serverGroups, eq(serverGroups.id, serverInstances.groupId))
        .innerJoin(executionHosts, eq(executionHosts.id, serverInstances.hostId))
        .where(
          and(
            eq(serverGroups.type, "hub"),
            eq(serverGroups.enabled, true),
            eq(serverInstances.lifecycleState, "RUNNING"),
            eq(serverInstances.availabilityState, "OPEN"),
            eq(executionHosts.healthState, "ONLINE"),
            eq(executionHosts.adminState, "ACTIVE"),
            ne(serverInstances.id, sourceInstanceId),
            isNotNull(serverInstances.endpoint),
          ),
        )) as {
          id: string;
          endpoint: string;
          playerCount: number;
          maximumPlayers: number;
          pendingPlayers: number;
        }[];

      const candidates: HubTarget[] = targets.map((target) => ({
        id: target.id,
        endpoint: target.endpoint,
        maximumPlayers: Number(target.maximumPlayers),
        effectiveLoad: Number(target.playerCount) + Number(target.pendingPlayers),
      }));
      const playersToRoute = playerIds.filter(
        (playerId) => connectedIds.has(playerId) && !acceptedIds.has(playerId),
      );
      const decision = allocateHubPlayers(playersToRoute, candidates);

      for (const assignment of decision.assignments) {
        const target = candidates.find(
          (candidate) => candidate.id === assignment.targetId,
        );
        if (!target) continue;
        await this.transfers.enqueue(tx, {
          instanceId: target.id,
          endpoint: target.endpoint,
          players: assignment.playerIds,
          sourceInstanceId,
          ...(reason ? { reason } : {}),
        });
        assignment.playerIds.forEach((playerId) => acceptedIds.add(playerId));
      }

      return {
        acceptedPlayers: playerIds.filter((playerId) => acceptedIds.has(playerId)),
        rejectedPlayers: playerIds.filter((playerId) => !acceptedIds.has(playerId)),
      };
    });
  }
}
