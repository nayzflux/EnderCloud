import type { SqlClient } from "../db/client.ts";
import type postgres from "postgres";
import { packParties } from "../domain/matchmaking.ts";
import type { QueueParty, TeamAssignment } from "../domain/types.ts";
import type { Logger } from "../logger.ts";
import { nanoid } from "../id.ts";
import type { TransferService } from "./transfer-service.ts";

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

export class Matchmaker {
  private running = false;

  public constructor(
    private readonly sql: SqlClient,
    private readonly transfers: TransferService,
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
        try {
          while (await this.assignWaitingSession(group)) {
            // Assign every available warm instance before forming more sessions.
          }
          await this.backfill(group);
          for (let formed = 0; formed < 32 && (await this.formSession(group)); formed += 1) {
            // Drain the currently matchable queue without monopolising the scheduler forever.
          }
        } catch (error) {
          this.logger.error("Matchmaking group tick failed", {
            groupId: group.id,
            error: String(error),
          });
        }
      }
    } catch (error) {
      this.logger.error("Matchmaking tick failed", { error: String(error) });
    } finally {
      this.running = false;
    }
  }

  private async formSession(group: GroupRow): Promise<boolean> {
    return this.sql.begin<boolean>(async (transaction) => {
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
      if (packed.playerCount < group.minimum_players) return false;

      const sessionId = nanoid();
      const reservations = await transaction<Reservation[]>`
        SELECT id, endpoint
        FROM server_instances
        WHERE group_id = ${group.id}
           AND lifecycle_state = 'RUNNING'
           AND availability_state = 'OPEN'
           AND endpoint IS NOT NULL
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
      await this.persistSelection(
        transaction,
        sessionId,
        packed.teams,
        packed.selected,
        Boolean(reservation),
      );
      if (reservation) {
        await this.transfers.enqueue(
          transaction,
          {
            instanceId: reservation.id,
            endpoint: reservation.endpoint,
            players: packed.selected.flatMap((party) => [...party.playerIds]),
          },
          sessionId,
        );
        await transaction`
          UPDATE game_sessions
          SET transfer_started_at = now()
          WHERE id = ${sessionId}
        `;
      }
      return true;
    });
  }

  private async assignWaitingSession(group: GroupRow): Promise<boolean> {
    return this.sql.begin<boolean>(async (transaction) => {
      const sessions = await transaction<{ id: string }[]>`
        SELECT id FROM game_sessions
        WHERE group_id = ${group.id} AND state = 'WAITING_FOR_INSTANCE'
          AND waiting_deadline > now()
        ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED
      `;
      const session = sessions[0];
      if (!session) return false;
      const reservations = await transaction<Reservation[]>`
        SELECT id, endpoint FROM server_instances
        WHERE group_id = ${group.id}
          AND lifecycle_state = 'RUNNING' AND availability_state = 'OPEN'
          AND endpoint IS NOT NULL
        ORDER BY running_at LIMIT 1 FOR UPDATE SKIP LOCKED
      `;
      const reservation = reservations[0];
      if (!reservation) return false;
      await transaction`
        UPDATE server_instances
        SET availability_state = 'RESERVED', session_id = ${session.id}, updated_at = now()
        WHERE id = ${reservation.id}
      `;
      await transaction`
        UPDATE game_sessions
        SET instance_id = ${reservation.id}, state = 'TRANSFERRING',
            transfer_started_at = now(),
            waiting_deadline = now() + (
              ${group.waiting_timeout_ms} * interval '1 millisecond'
            ),
            updated_at = now()
        WHERE id = ${session.id}
      `;
      await transaction`
        UPDATE session_players
        SET state = 'TRANSFERRING', transferring_at = now()
        WHERE session_id = ${session.id} AND state = 'SELECTED'
      `;
      const players = await transaction<{ player_id: string }[]>`
        SELECT player_id FROM session_players
        WHERE session_id = ${session.id} AND state <> 'LEFT'
      `;
      await this.transfers.enqueue(
        transaction,
        {
          instanceId: reservation.id,
          endpoint: reservation.endpoint,
          players: players.map((player) => player.player_id),
        },
        session.id,
      );
      return true;
    });
  }

  private async backfill(group: GroupRow): Promise<void> {
    const candidates = await this.sql<{ id: string }[]>`
      SELECT id
      FROM game_sessions
      WHERE group_id = ${group.id}
        AND state IN ('TRANSFERRING', 'WAITING')
        AND waiting_deadline > now()
      ORDER BY created_at
    `;
    for (const candidate of candidates) {
      await this.backfillSession(group, candidate.id);
    }
  }

  private async backfillSession(group: GroupRow, sessionId: string): Promise<boolean> {
    return this.sql.begin<boolean>(async (transaction) => {
      const sessions = await transaction<{
        id: string;
        instance_id: string;
        endpoint: string;
      }[]>`
        SELECT s.id, s.instance_id, i.endpoint
        FROM game_sessions s
        JOIN server_instances i ON i.id = s.instance_id
        WHERE s.id = ${sessionId}
          AND s.group_id = ${group.id}
          AND s.state IN ('TRANSFERRING', 'WAITING')
          AND s.waiting_deadline > now()
          AND i.lifecycle_state = 'RUNNING'
          AND i.endpoint IS NOT NULL
        FOR UPDATE OF s SKIP LOCKED
      `;
      const session = sessions[0];
      if (!session) return false;
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
      if (existing.length >= group.maximum_players) return false;
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
      if (packed.selected.length === 0) return false;
      await this.persistSelection(
        transaction,
        session.id,
        packed.teams,
        packed.selected,
        true,
      );
      await transaction`
        UPDATE game_sessions
        SET assignment_revision = assignment_revision + 1,
            assignment_acknowledged_at = NULL, updated_at = now()
        WHERE id = ${session.id}
      `;
      await this.transfers.enqueue(
        transaction,
        {
          instanceId: session.instance_id,
          endpoint: session.endpoint,
          players: packed.selected.flatMap((party) => [...party.playerIds]),
        },
        session.id,
      );
      return true;
    });
  }

  private async persistSelection(
    transaction: postgres.TransactionSql,
    sessionId: string,
    teams: readonly TeamAssignment[],
    selected: readonly QueueParty[],
    transferring: boolean,
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
              session_id, player_id, party_id, team_index, state, transferring_at
            ) VALUES (
              ${sessionId}, ${playerId}, ${party.partyId}, ${team.teamIndex},
              ${transferring ? "TRANSFERRING" : "SELECTED"},
              CASE WHEN ${transferring}::boolean THEN now() ELSE NULL END
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
