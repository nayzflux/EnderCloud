import type { SqlClient } from "../db/client.ts";
import { nanoid } from "../id.ts";

export interface EnqueueRequest {
  readonly groupId: string;
  readonly partyId: string;
  readonly players: readonly string[];
}

export class QueueService {
  public constructor(private readonly sql: SqlClient) {}

  // Validate a party and add it to matchmaking without duplicating active players.
  public async enqueue(request: EnqueueRequest): Promise<{ entryId: string; state: string }> {
    if (request.players.length === 0 || new Set(request.players).size !== request.players.length) {
      throw new Error("A party must contain distinct players");
    }
    // Validation and insertion share one transaction so concurrent requests cannot interleave.
    return this.sql.begin(async (transaction) => {
      const groups = await transaction<{
        type: string;
        enabled: boolean;
        team_size: number | null;
      }[]>`
        SELECT type, enabled, team_size FROM server_groups
        WHERE id = ${request.groupId} FOR SHARE
      `;
      const group = groups[0];
      if (!group || group.type !== "minigame" || !group.enabled) {
        throw new Error("The requested matchmaking group is unavailable");
      }
      if (!group.team_size || request.players.length > group.team_size) {
        throw new Error("The party is larger than a team");
      }
      const existing = await transaction<{ id: string; state: string }[]>`
        SELECT id, state FROM queue_entries
        WHERE group_id = ${request.groupId}
          AND party_id = ${request.partyId}
          AND state = 'QUEUED'
        LIMIT 1
      `;
      // Repeated enqueue calls from the proxy are idempotent for the same active party.
      if (existing[0]) {
        return { entryId: existing[0].id, state: existing[0].state };
      }
      // Check every member because a party is rejected as a whole when any player is busy.
      for (const playerId of request.players) {
        const conflicts = await transaction<{ exists: boolean }[]>`
          SELECT EXISTS (
            SELECT 1
            FROM queue_entry_players qp
            JOIN queue_entries q ON q.id = qp.queue_entry_id
            WHERE qp.player_id = ${playerId} AND q.state = 'QUEUED'
          ) OR EXISTS (
            SELECT 1 FROM session_players sp
            JOIN game_sessions s ON s.id = sp.session_id
            WHERE sp.player_id = ${playerId}
              AND sp.state <> 'LEFT'
              AND s.state NOT IN ('FINISHED', 'CANCELLED', 'FAILED')
          ) AS exists
        `;
        if (conflicts[0]?.exists) throw new Error(`Player ${playerId} is already matchmaking`);
      }
      // Create the parent before membership rows; the transaction hides partial parties.
      const entryId = nanoid();
      await transaction`
        INSERT INTO queue_entries (id, group_id, party_id)
        VALUES (${entryId}, ${request.groupId}, ${request.partyId})
      `;
      // Membership is normalized into one row per player for efficient conflict checks.
      for (const playerId of request.players) {
        await transaction`
          INSERT INTO queue_entry_players (queue_entry_id, player_id)
          VALUES (${entryId}, ${playerId})
        `;
      }
      return { entryId, state: "QUEUED" };
    });
  }

  // Withdraw an entire party while it is still queued.
  public async leaveParty(groupId: string, partyId: string): Promise<boolean> {
    const rows = await this.sql<{ id: string }[]>`
      UPDATE queue_entries
      SET state = 'LEFT', updated_at = now()
      WHERE group_id = ${groupId} AND party_id = ${partyId} AND state = 'QUEUED'
      RETURNING id
    `;
    return rows.length > 0;
  }

  // Remove a disconnected player from whichever active matchmaking stage owns it.
  public async networkDisconnected(playerId: string): Promise<void> {
    await this.sql.begin(async (transaction) => {
      const queued = await transaction<{ queue_entry_id: string }[]>`
        SELECT qp.queue_entry_id
        FROM queue_entry_players qp
        JOIN queue_entries q ON q.id = qp.queue_entry_id
        WHERE qp.player_id = ${playerId} AND q.state = 'QUEUED'
        LIMIT 1 FOR UPDATE OF q
      `;
      // A queued player represents the whole party, so disconnecting cancels that party entry.
      if (queued[0]) {
        await transaction`
          UPDATE queue_entries SET state = 'LEFT', updated_at = now()
          WHERE id = ${queued[0].queue_entry_id}
        `;
        return;
      }
      await transaction`
        UPDATE session_players
        SET state = 'LEFT', left_at = now()
        WHERE player_id = ${playerId} AND state <> 'LEFT'
          AND session_id IN (
            SELECT id FROM game_sessions
            WHERE state NOT IN ('FINISHED', 'CANCELLED', 'FAILED')
          )
      `;
    });
  }
}
