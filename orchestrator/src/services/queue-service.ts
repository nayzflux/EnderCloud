import type { Database } from "../db/client.ts";
import { serverGroups, queueEntries, queueEntryPlayers, sessionPlayers, gameSessions } from "../db/schema.ts";
import { desc, eq, and, inArray, isNull, notInArray, or, sql } from "drizzle-orm";
import { nanoid } from "../id.ts";
import {
  computeFeasibleProfiles,
  isProfileEligible,
  selectRecommendedProfile,
} from "../domain/matchmaking.ts";

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
        .select({
          id: queueEntries.id,
          state: queueEntries.state,
          sessionId: queueEntries.sessionId,
        })
        .from(queueEntries)
        .leftJoin(gameSessions, eq(gameSessions.id, queueEntries.sessionId))
        .where(
          and(
            eq(queueEntries.groupId, request.groupId),
            eq(queueEntries.partyId, request.partyId),
            or(
              eq(queueEntries.state, "QUEUED"),
              and(
                eq(queueEntries.state, "SELECTED"),
                notInArray(gameSessions.state, ["FINISHED", "CANCELLED", "FAILED"]),
              ),
            ),
          )
        )
        .orderBy(
          sql`CASE WHEN ${queueEntries.state} = 'QUEUED' THEN 0 ELSE 1 END`,
          desc(queueEntries.joinedAt),
        )
        .limit(1);
      const existingEntry = existing[0];
      // A queued ticket is always an idempotent retry. A selected ticket is
      // idempotent only while the exact requested membership is still active.
      if (existingEntry?.state === "QUEUED") {
        return { entryId: existingEntry.id, state: existingEntry.state };
      }
      if (existingEntry?.state === "SELECTED" && existingEntry.sessionId) {
        const activeMembers = await tx.select({ playerId: sessionPlayers.playerId })
          .from(sessionPlayers)
          .where(
            and(
              eq(sessionPlayers.sessionId, existingEntry.sessionId),
              or(
                eq(sessionPlayers.queueEntryId, existingEntry.id),
                and(
                  isNull(sessionPlayers.queueEntryId),
                  eq(sessionPlayers.partyId, request.partyId),
                ),
              ),
              sql`${sessionPlayers.state} <> 'LEFT'`,
            ),
          );
        const activeIds = new Set(activeMembers.map((member) => member.playerId));
        if (
          activeIds.size === request.players.length &&
          request.players.every((playerId) => activeIds.has(playerId))
        ) {
          return { entryId: existingEntry.id, state: existingEntry.state };
        }
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

  // Withdraw an entire party until its first transfer command establishes the individual boundary.
  public async leaveParty(groupId: string, partyId: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const entries = await tx.select({
        id: queueEntries.id,
        state: queueEntries.state,
        sessionId: queueEntries.sessionId,
        transferStartedAt: queueEntries.transferStartedAt,
      })
        .from(queueEntries)
        .leftJoin(gameSessions, eq(gameSessions.id, queueEntries.sessionId))
        .where(
          and(
            eq(queueEntries.groupId, groupId),
            eq(queueEntries.partyId, partyId),
            or(
              eq(queueEntries.state, "QUEUED"),
              and(
                eq(queueEntries.state, "SELECTED"),
                notInArray(gameSessions.state, ["FINISHED", "CANCELLED", "FAILED"]),
              ),
            ),
          ),
        )
        .orderBy(sql`CASE WHEN ${queueEntries.state} = 'QUEUED' THEN 0 ELSE 1 END`)
        .limit(1)
        .for("update", { of: queueEntries });
      const entry = entries[0];
      if (!entry || entry.transferStartedAt) return false;
      await this.cancelTicket(tx, entry.id, entry.sessionId, partyId);
      return true;
    });
  }

  // Remove a disconnected player from whichever active matchmaking stage owns it.
  public async networkDisconnected(playerId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const queued = await tx
        .select({
          queue_entry_id: queueEntryPlayers.queueEntryId,
          party_id: queueEntries.partyId,
          state: queueEntries.state,
          session_id: queueEntries.sessionId,
          transfer_started_at: queueEntries.transferStartedAt,
        })
        .from(queueEntryPlayers)
        .innerJoin(queueEntries, eq(queueEntries.id, queueEntryPlayers.queueEntryId))
        .leftJoin(gameSessions, eq(gameSessions.id, queueEntries.sessionId))
        .where(
          and(
            eq(queueEntryPlayers.playerId, playerId),
            or(
              eq(queueEntries.state, "QUEUED"),
              and(
                eq(queueEntries.state, "SELECTED"),
                notInArray(gameSessions.state, ["FINISHED", "CANCELLED", "FAILED"]),
              ),
            ),
          )
        )
        .orderBy(sql`CASE WHEN ${queueEntries.state} = 'QUEUED' THEN 0 ELSE 1 END`)
        .limit(1)
        .for("update", { of: queueEntries });
      // Before a command exists the ticket remains atomic; afterwards only this player leaves.
      if (queued[0] && !queued[0].transfer_started_at) {
        await this.cancelTicket(
          tx,
          queued[0].queue_entry_id as string,
          queued[0].session_id,
          queued[0].party_id,
        );
        return;
      }
      const changed = await tx
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
        )
        .returning({ sessionId: sessionPlayers.sessionId });
      if (changed[0]) {
        await tx.update(gameSessions)
          .set({
            assignmentRevision: sql`${gameSessions.assignmentRevision} + 1`,
            assignmentAcknowledgedAt: null,
            updatedAt: sql`now()`,
          })
          .where(eq(gameSessions.id, changed[0].sessionId));
      }
    });
  }

  private async cancelTicket(
    tx: any,
    entryId: string,
    sessionId: string | null,
    partyId: string,
  ): Promise<void> {
    await tx.update(queueEntries)
      .set({ state: "LEFT", updatedAt: sql`now()` })
      .where(eq(queueEntries.id, entryId));
    if (!sessionId) return;
    const changed = await tx.update(sessionPlayers)
      .set({ state: "LEFT", leftAt: sql`now()` })
      .where(
        and(
          eq(sessionPlayers.sessionId, sessionId),
          or(
            eq(sessionPlayers.queueEntryId, entryId),
            and(
              isNull(sessionPlayers.queueEntryId),
              eq(sessionPlayers.partyId, partyId),
            ),
          ),
          sql`${sessionPlayers.state} <> 'LEFT'`,
        ),
      )
      .returning({ playerId: sessionPlayers.playerId });
    if (changed.length === 0) return;

    const sessionRows = await tx.select({
      state: gameSessions.state,
      groupId: gameSessions.groupId,
      minimumPlayers: serverGroups.minimumPlayers,
      teamCount: serverGroups.teamCount,
      teamSize: serverGroups.teamSize,
      minimumPlayersPerTeam: serverGroups.minimumPlayersPerTeam,
      maximumTeamSpread: serverGroups.maximumTeamSpread,
    })
      .from(gameSessions)
      .innerJoin(serverGroups, eq(serverGroups.id, gameSessions.groupId))
      .where(eq(gameSessions.id, sessionId))
      .for("update", { of: gameSessions });
    const session = sessionRows[0];
    if (!session) return;

    const sizes = (await tx.execute(sql`
      SELECT count(*)::integer AS size
      FROM session_players
      WHERE session_id = ${sessionId} AND state <> 'LEFT'
      GROUP BY COALESCE(queue_entry_id, 'legacy:' || party_id)
    `)) as unknown as { size: number }[];
    const ticketSizes = sizes.map((row) => Number(row.size));
    const playerCount = ticketSizes.reduce((sum, size) => sum + size, 0);
    const profiles = computeFeasibleProfiles(
      ticketSizes,
      session.teamCount ?? 1,
      session.teamSize ?? 1,
    );
    const eligible =
      playerCount >= (session.minimumPlayers ?? 1) &&
      isProfileEligible(
        selectRecommendedProfile(profiles),
        session.minimumPlayersPerTeam ?? 0,
        session.maximumTeamSpread ?? session.teamSize ?? 1,
      );
    await tx.update(gameSessions)
      .set({
        state:
          playerCount === 0
            ? "CANCELLED"
            : session.state === "WAITING_FOR_INSTANCE" && !eligible
              ? "FORMING"
              : session.state,
        instanceAcquisitionDeadline:
          session.state === "WAITING_FOR_INSTANCE" && !eligible ? null : undefined,
        lobbyStaleDeadline:
          session.state === "WAITING_FOR_INSTANCE" && !eligible ? null : undefined,
        assignmentRevision: sql`${gameSessions.assignmentRevision} + 1`,
        assignmentAcknowledgedAt: null,
        updatedAt: sql`now()`,
      })
      .where(eq(gameSessions.id, sessionId));
  }
}
