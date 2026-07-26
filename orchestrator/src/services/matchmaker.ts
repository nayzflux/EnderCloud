import type { SqlClient } from "../db/client.ts";
import type postgres from "postgres";
import { packParties } from "../domain/matchmaking.ts";
import type { QueueParty, TeamAssignment } from "../domain/types.ts";
import type { RedisEventBus } from "../events/redis-bus.ts";
import type { Logger } from "../logger.ts";
import { nanoid } from "../id.ts";

interface GroupRow {
  id: string;
  minimum_players: number;
  maximum_players: number;
  team_count: number;
  team_size: number;
  waiting_timeout_ms: number;
}

interface QueueRow {
  entry_id: string;
  party_id: string;
  joined_at: Date;
  player_ids: string[];
}

interface Reservation {
  id: string;
  endpoint: string;
}

interface Transfer {
  instanceId: string;
  endpoint: string;
  players: string[];
}

export class Matchmaker {
  private running = false;

  public constructor(
    private readonly sql: SqlClient,
    private readonly bus: RedisEventBus,
    private readonly logger: Logger,
  ) {}

  public async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const groups = await this.sql<GroupRow[]>`
        SELECT id, minimum_players, maximum_players, team_count, team_size,
               waiting_timeout_ms
        FROM server_groups
        WHERE type = 'minigame' AND enabled = true
      `;
      for (const group of groups) {
        await this.assignWaitingSession(group);
        await this.backfill(group);
        await this.formSession(group);
      }
    } catch (error) {
      this.logger.error("Matchmaking tick failed", { error: String(error) });
    } finally {
      this.running = false;
    }
  }

  private async formSession(group: GroupRow): Promise<void> {
    const transfer = await this.sql.begin<Transfer | null>(async (transaction) => {
      const queue = await transaction<QueueRow[]>`
        WITH locked_entries AS (
          SELECT q.id, q.party_id, q.joined_at
          FROM queue_entries q
          WHERE q.group_id = ${group.id} AND q.state = 'QUEUED'
          ORDER BY q.joined_at
          FOR UPDATE SKIP LOCKED
        )
        SELECT q.id AS entry_id, q.party_id, q.joined_at,
               array_agg(qp.player_id ORDER BY qp.player_id)::text[] AS player_ids
        FROM locked_entries q
        JOIN queue_entry_players qp ON qp.queue_entry_id = q.id
        GROUP BY q.id, q.party_id, q.joined_at
        ORDER BY q.joined_at
      `;
      const parties = this.toParties(queue);
      const packed = packParties(
        parties,
        group.team_count,
        group.team_size,
        group.maximum_players,
      );
      if (packed.playerCount < group.minimum_players) return null;

      const sessionId = nanoid();
      const reservations = await transaction<Reservation[]>`
        SELECT id, endpoint
        FROM server_instances
        WHERE group_id = ${group.id}
          AND lifecycle_state = 'RUNNING'
          AND availability_state = 'OPEN'
        ORDER BY running_at
        LIMIT 1 FOR UPDATE SKIP LOCKED
      `;
      const reservation = reservations[0];
      const state = reservation ? "TRANSFERRING" : "WAITING_FOR_INSTANCE";
      await transaction`
        INSERT INTO game_sessions (
          id, group_id, instance_id, state, waiting_deadline
        ) VALUES (
          ${sessionId}, ${group.id}, ${reservation?.id ?? null}, ${state},
          now() + (${group.waiting_timeout_ms} * interval '1 millisecond')
        )
      `;
      if (reservation) {
        await transaction`
          UPDATE server_instances
          SET availability_state = 'RESERVED', session_id = ${sessionId}, updated_at = now()
          WHERE id = ${reservation.id}
            AND lifecycle_state = 'RUNNING' AND availability_state = 'OPEN'
        `;
      }
      await this.persistSelection(transaction, sessionId, packed.teams, packed.selected);
      if (!reservation) return null;
      return {
        instanceId: reservation.id,
        endpoint: reservation.endpoint,
        players: packed.selected.flatMap((party) => [...party.playerIds]),
      };
    });
    if (transfer) await this.bus.publishTransfer(transfer);
  }

  private async assignWaitingSession(group: GroupRow): Promise<void> {
    const transfer = await this.sql.begin<Transfer | null>(async (transaction) => {
      const sessions = await transaction<{ id: string }[]>`
        SELECT id FROM game_sessions
        WHERE group_id = ${group.id} AND state = 'WAITING_FOR_INSTANCE'
        ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED
      `;
      const session = sessions[0];
      if (!session) return null;
      const reservations = await transaction<Reservation[]>`
        SELECT id, endpoint FROM server_instances
        WHERE group_id = ${group.id}
          AND lifecycle_state = 'RUNNING' AND availability_state = 'OPEN'
        ORDER BY running_at LIMIT 1 FOR UPDATE SKIP LOCKED
      `;
      const reservation = reservations[0];
      if (!reservation) return null;
      await transaction`
        UPDATE server_instances
        SET availability_state = 'RESERVED', session_id = ${session.id}, updated_at = now()
        WHERE id = ${reservation.id}
      `;
      await transaction`
        UPDATE game_sessions
        SET instance_id = ${reservation.id}, state = 'TRANSFERRING', updated_at = now()
        WHERE id = ${session.id}
      `;
      await transaction`
        UPDATE session_players SET state = 'TRANSFERRING'
        WHERE session_id = ${session.id} AND state = 'SELECTED'
      `;
      const players = await transaction<{ player_id: string }[]>`
        SELECT player_id FROM session_players
        WHERE session_id = ${session.id} AND state <> 'LEFT'
      `;
      return {
        instanceId: reservation.id,
        endpoint: reservation.endpoint,
        players: players.map((player) => player.player_id),
      };
    });
    if (transfer) await this.bus.publishTransfer(transfer);
  }

  private async backfill(group: GroupRow): Promise<void> {
    const transfer = await this.sql.begin<Transfer | null>(async (transaction) => {
      const sessions = await transaction<{
        id: string;
        instance_id: string;
        endpoint: string;
      }[]>`
        SELECT s.id, s.instance_id, i.endpoint
        FROM game_sessions s
        JOIN server_instances i ON i.id = s.instance_id
        WHERE s.group_id = ${group.id}
          AND s.state IN ('TRANSFERRING', 'WAITING')
          AND s.waiting_deadline > now()
        ORDER BY s.created_at LIMIT 1 FOR UPDATE OF s SKIP LOCKED
      `;
      const session = sessions[0];
      if (!session) return null;
      const existing = await transaction<{
        player_id: string;
        party_id: string;
        team_index: number;
      }[]>`
        SELECT player_id, party_id, team_index
        FROM session_players
        WHERE session_id = ${session.id} AND state <> 'LEFT'
        ORDER BY selected_at
      `;
      if (existing.length >= group.maximum_players) return null;
      const initialTeams = this.toInitialTeams(existing, group.team_count);
      const queue = await transaction<QueueRow[]>`
        WITH locked_entries AS (
          SELECT q.id, q.party_id, q.joined_at
          FROM queue_entries q
          WHERE q.group_id = ${group.id} AND q.state = 'QUEUED'
          ORDER BY q.joined_at
          FOR UPDATE SKIP LOCKED
        )
        SELECT q.id AS entry_id, q.party_id, q.joined_at,
               array_agg(qp.player_id ORDER BY qp.player_id)::text[] AS player_ids
        FROM locked_entries q
        JOIN queue_entry_players qp ON qp.queue_entry_id = q.id
        GROUP BY q.id, q.party_id, q.joined_at
        ORDER BY q.joined_at
      `;
      const packed = packParties(
        this.toParties(queue),
        group.team_count,
        group.team_size,
        group.maximum_players,
        initialTeams,
      );
      if (packed.selected.length === 0) return null;
      await this.persistSelection(transaction, session.id, packed.teams, packed.selected);
      await transaction`
        UPDATE game_sessions
        SET assignment_revision = assignment_revision + 1,
            assignment_acknowledged_at = NULL, updated_at = now()
        WHERE id = ${session.id}
      `;
      return {
        instanceId: session.instance_id,
        endpoint: session.endpoint,
        players: packed.selected.flatMap((party) => [...party.playerIds]),
      };
    });
    if (transfer) await this.bus.publishTransfer(transfer);
  }

  private async persistSelection(
    transaction: postgres.TransactionSql,
    sessionId: string,
    teams: readonly TeamAssignment[],
    selected: readonly QueueParty[],
  ): Promise<void> {
    const selectedIds = new Set(selected.map((party) => party.entryId));
    for (const team of teams) {
      for (const party of team.parties) {
        if (!selectedIds.has(party.entryId)) continue;
        await transaction`
          UPDATE queue_entries SET state = 'SELECTED', updated_at = now()
          WHERE id = ${party.entryId} AND state = 'QUEUED'
        `;
        for (const playerId of party.playerIds) {
          await transaction`
            INSERT INTO session_players (
              session_id, player_id, party_id, team_index, state
            ) VALUES (
              ${sessionId}, ${playerId}, ${party.partyId}, ${team.teamIndex}, 'TRANSFERRING'
            )
            ON CONFLICT (session_id, player_id) DO NOTHING
          `;
        }
      }
    }
  }

  private toParties(rows: readonly QueueRow[]): QueueParty[] {
    return rows.map((row) => ({
      entryId: row.entry_id,
      partyId: row.party_id,
      joinedAt: new Date(row.joined_at),
      playerIds: row.player_ids,
    }));
  }

  private toInitialTeams(
    players: readonly { player_id: string; party_id: string; team_index: number }[],
    teamCount: number,
  ): TeamAssignment[] {
    return Array.from({ length: teamCount }, (_, teamIndex) => {
      const teamPlayers = players.filter((player) => player.team_index === teamIndex);
      const byParty = new Map<string, string[]>();
      for (const player of teamPlayers) {
        const party = byParty.get(player.party_id) ?? [];
        party.push(player.player_id);
        byParty.set(player.party_id, party);
      }
      const parties = [...byParty.entries()].map(([partyId, playerIds]) => ({
        entryId: `existing:${partyId}`,
        partyId,
        playerIds,
        joinedAt: new Date(0),
      }));
      return { teamIndex, parties, playerIds: teamPlayers.map((player) => player.player_id) };
    });
  }
}
