import type { Database } from "../db/client.ts";
import { serverGroups, queueEntries, queueEntryPlayers, sessionPlayers, gameSessions } from "../db/schema.ts";
import { eq, and, inArray, notInArray, sql } from "drizzle-orm";
import { nanoid } from "../id.ts";

export interface EnqueueRequest {
  readonly groupId: string;
  readonly partyId: string;
  readonly players: readonly string[];
}

export class QueueService {
  public constructor(private readonly db: Database) {}

  // Validate a party and add it to matchmaking without duplicating active players.
  public async enqueue(request: EnqueueRequest): Promise<{ entryId: string; state: string }> {
    if (request.players.length === 0 || new Set(request.players).size !== request.players.length) {
      throw new Error("A party must contain distinct players");
    }
    // Validation and insertion share one transaction so concurrent requests cannot interleave.
    return this.db.transaction(async (tx) => {
      const groups = await tx
        .select({
          type: serverGroups.type,
          enabled: serverGroups.enabled,
          team_size: serverGroups.teamSize,
        })
        .from(serverGroups)
        .where(eq(serverGroups.id, request.groupId))
        .for("share");
      const groupRecord = groups[0];
      if (!groupRecord || groupRecord.type !== "minigame" || !groupRecord.enabled) {
        throw new Error("The requested matchmaking group is unavailable");
      }
      if (!groupRecord.team_size || request.players.length > groupRecord.team_size) {
        throw new Error("The party is larger than a team");
      }
      const existing = await tx
        .select({ id: queueEntries.id, state: queueEntries.state })
        .from(queueEntries)
        .where(
          and(
            eq(queueEntries.groupId, request.groupId),
            eq(queueEntries.partyId, request.partyId),
            eq(queueEntries.state, "QUEUED")
          )
        )
        .limit(1);
      // Repeated enqueue calls from the proxy are idempotent for the same active party.
      if (existing[0]) {
        return { entryId: existing[0].id, state: existing[0].state };
      }
      // Check every member because a party is rejected as a whole when any player is busy.
      for (const playerId of request.players) {
        const queueConflicts = tx
          .select({ dummy: sql`1` })
          .from(queueEntryPlayers)
          .innerJoin(queueEntries, eq(queueEntries.id, queueEntryPlayers.queueEntryId))
          .where(
            and(
              eq(queueEntryPlayers.playerId, playerId),
              eq(queueEntries.state, "QUEUED")
            )
          );

        const sessionConflicts = tx
          .select({ dummy: sql`1` })
          .from(sessionPlayers)
          .innerJoin(gameSessions, eq(gameSessions.id, sessionPlayers.sessionId))
          .where(
            and(
              eq(sessionPlayers.playerId, playerId),
              sql`${sessionPlayers.state} <> 'LEFT'`,
              notInArray(gameSessions.state, ["FINISHED", "CANCELLED", "FAILED"])
            )
          );

        const conflicts = await tx.execute(sql`SELECT EXISTS (${queueConflicts}) OR EXISTS (${sessionConflicts}) AS exists`) as unknown as { exists: boolean }[];
        if (conflicts[0]?.exists) throw new Error(`Player ${playerId} is already matchmaking`);
      }
      // Create the parent before membership rows; the transaction hides partial parties.
      const entryId = nanoid();
      await tx.insert(queueEntries).values({
        id: entryId,
        groupId: request.groupId,
        partyId: request.partyId,
      });
      // Membership is normalized into one row per player for efficient conflict checks.
      for (const playerId of request.players) {
        await tx.insert(queueEntryPlayers).values({
          queueEntryId: entryId,
          playerId: playerId,
        });
      }
      return { entryId, state: "QUEUED" };
    });
  }

  // Withdraw an entire party while it is still queued.
  public async leaveParty(groupId: string, partyId: string): Promise<boolean> {
    const rows = await this.db
      .update(queueEntries)
      .set({ state: "LEFT", updatedAt: sql`now()` })
      .where(
        and(
          eq(queueEntries.groupId, groupId),
          eq(queueEntries.partyId, partyId),
          eq(queueEntries.state, "QUEUED")
        )
      )
      .returning({ id: queueEntries.id });
    return rows.length > 0;
  }

  // Remove a disconnected player from whichever active matchmaking stage owns it.
  public async networkDisconnected(playerId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const queued = await tx
        .select({ queue_entry_id: queueEntryPlayers.queueEntryId })
        .from(queueEntryPlayers)
        .innerJoin(queueEntries, eq(queueEntries.id, queueEntryPlayers.queueEntryId))
        .where(
          and(
            eq(queueEntryPlayers.playerId, playerId),
            eq(queueEntries.state, "QUEUED")
          )
        )
        .limit(1)
        .for("update", { of: queueEntries });
      // A queued player represents the whole party, so disconnecting cancels that party entry.
      if (queued[0]) {
        await tx
          .update(queueEntries)
          .set({ state: "LEFT", updatedAt: sql`now()` })
          .where(eq(queueEntries.id, queued[0].queue_entry_id as string));
        return;
      }
      await tx
        .update(sessionPlayers)
        .set({ state: "LEFT", leftAt: sql`now()` })
        .where(
          and(
            eq(sessionPlayers.playerId, playerId),
            sql`${sessionPlayers.state} <> 'LEFT'`,
            inArray(
              sessionPlayers.sessionId,
              tx.select({ id: gameSessions.id })
                .from(gameSessions)
                .where(notInArray(gameSessions.state, ["FINISHED", "CANCELLED", "FAILED"]))
            )
          )
        );
    });
  }
}
