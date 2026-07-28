import type { Database } from "../db/client.ts";
import { sql, eq, and, ne, inArray, isNotNull } from "drizzle-orm";
import {
  serverGroups,
  queueEntries,
  queueEntryPlayers,
  serverInstances,
  gameSessions,
  sessionPlayers,
} from "../db/schema.ts";
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
    private readonly db: Database,
    private readonly transfers: TransferService,
    private readonly logger: Logger,
  ) {}

  // Assign waiting sessions, backfill active lobbies, then form new sessions.
  public async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const groups = (await this.db
        .select({
          id: serverGroups.id,
          minimum_players: serverGroups.minimumPlayers,
          maximum_players: serverGroups.maximumPlayers,
          team_count: serverGroups.teamCount,
          team_size: serverGroups.teamSize,
          waiting_timeout_ms: serverGroups.waitingTimeoutMs,
        })
        .from(serverGroups)
        .where(
          and(
            eq(serverGroups.type, "minigame"),
            eq(serverGroups.enabled, true),
          ),
        )) as unknown as GroupRow[];
      // Process groups independently so a failure in one game mode does not stop others.
      for (const group of groups) {
        try {
          // Consume all currently available warm instances for already-formed sessions first.
          while (await this.assignWaitingSession(group)) {
            // Assign every available warm instance before forming more sessions.
          }
          // Fill sessions that already own an instance before consuming queue entries for new sessions.
          await this.backfill(group);
          // The hard cap keeps one busy group from monopolizing the scheduler tick.
          for (
            let formed = 0;
            formed < 32 && (await this.formSession(group));
            formed += 1
          ) {
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

  // Select queued parties, reserve a warm instance, and persist a new session.
  private async formSession(group: GroupRow): Promise<boolean> {
    return this.db.transaction(async (tx: any) => {
      // Row locks plus SKIP LOCKED allow multiple orchestrator workers to form
      // sessions concurrently without selecting the same queued party twice.
      const queue = (await tx.execute(sql`
        WITH locked_entries AS (
          SELECT q.id, q.party_id, q.joined_at
          FROM queue_entries q
          WHERE q.group_id = ${group.id} AND q.state = 'QUEUED'
          -- Oldest parties are considered first for queue fairness.
          ORDER BY q.joined_at
          -- Locked rows are skipped so concurrent workers never select the same party.
          FOR UPDATE SKIP LOCKED
        )
        SELECT q.id AS entry_id, q.party_id, q.joined_at,
               array_agg(qp.player_id ORDER BY qp.player_id)::text[] AS player_ids
        FROM locked_entries q
        JOIN queue_entry_players qp ON qp.queue_entry_id = q.id
        GROUP BY q.id, q.party_id, q.joined_at
        ORDER BY q.joined_at
      `)) as unknown as QueueRow[];

      const parties = this.toParties(queue);
      const packed = packParties(
        parties,
        group.team_count,
        group.team_size,
        group.maximum_players,
      );
      // Do not consume queue entries until a valid minimum-sized match can be committed.
      if (packed.playerCount < group.minimum_players) return false;

      const sessionId = nanoid();
      const reservations = (await tx
        .select({
          id: serverInstances.id,
          endpoint: serverInstances.endpoint,
        })
        .from(serverInstances)
        .where(
          and(
            eq(serverInstances.groupId, group.id),
            eq(serverInstances.lifecycleState, "RUNNING"),
            eq(serverInstances.availabilityState, "OPEN"),
            isNotNull(serverInstances.endpoint),
          ),
        )
        // Prefer the oldest warm instance to rotate the pool predictably.
        .orderBy(serverInstances.runningAt)
        // Lock the reservation candidate so only this tx can claim it.
        .limit(1)
        .for("update", { skipLocked: true })) as unknown as Reservation[];
      const reservation = reservations[0];
      // Session formation is allowed without capacity; it can wait while autoscaling catches up.
      const state = reservation ? "TRANSFERRING" : "WAITING_FOR_INSTANCE";

      await tx.insert(gameSessions).values({
        id: sessionId,
        groupId: group.id,
        instanceId: reservation?.id ?? null,
        state: state,
        waitingDeadline: sql`now() + (${group.waiting_timeout_ms} * interval '1 millisecond')`,
      });

      if (reservation) {
        // Reserve the instance in the same tx as the session to prevent double assignment.
        await tx
          .update(serverInstances)
          .set({
            availabilityState: "RESERVED",
            sessionId: sessionId,
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(serverInstances.id, reservation.id),
              eq(serverInstances.lifecycleState, "RUNNING"),
              eq(serverInstances.availabilityState, "OPEN"),
            ),
          );
      }
      await this.persistSelection(
        tx,
        sessionId,
        packed.teams,
        packed.selected,
        Boolean(reservation),
      );
      if (reservation) {
        await this.transfers.enqueue(
          tx,
          {
            instanceId: reservation.id,
            endpoint: reservation.endpoint,
            players: packed.selected.flatMap((party) => [...party.playerIds]),
          },
          sessionId,
        );
        await tx
          .update(gameSessions)
          .set({ transferStartedAt: sql`now()` })
          .where(eq(gameSessions.id, sessionId));
      }
      return true;
    });
  }

  // Attach the oldest waiting session to the next available warm instance.
  private async assignWaitingSession(group: GroupRow): Promise<boolean> {
    return this.db.transaction(async (tx: any) => {
      const sessions = (await tx
        .select({ id: gameSessions.id })
        .from(gameSessions)
        .where(
          and(
            eq(gameSessions.groupId, group.id),
            eq(gameSessions.state, "WAITING_FOR_INSTANCE"),
            sql`${gameSessions.waitingDeadline} > now()`,
          ),
        )
        .orderBy(gameSessions.createdAt)
        .limit(1)
        .for("update", { skipLocked: true })) as unknown as { id: string }[];
      const session = sessions[0];
      if (!session) return false;
      const reservations = (await tx
        .select({
          id: serverInstances.id,
          endpoint: serverInstances.endpoint,
        })
        .from(serverInstances)
        .where(
          and(
            eq(serverInstances.groupId, group.id),
            eq(serverInstances.lifecycleState, "RUNNING"),
            eq(serverInstances.availabilityState, "OPEN"),
            isNotNull(serverInstances.endpoint),
          ),
        )
        .orderBy(serverInstances.runningAt)
        .limit(1)
        .for("update", { skipLocked: true })) as unknown as Reservation[];
      const reservation = reservations[0];
      if (!reservation) return false;

      await tx
        .update(serverInstances)
        .set({
          availabilityState: "RESERVED",
          sessionId: session.id,
          updatedAt: sql`now()`,
        })
        .where(eq(serverInstances.id, reservation.id));

      await tx
        .update(gameSessions)
        .set({
          instanceId: reservation.id,
          state: "TRANSFERRING",
          transferStartedAt: sql`now()`,
          waitingDeadline: sql`now() + (${group.waiting_timeout_ms} * interval '1 millisecond')`,
          updatedAt: sql`now()`,
        })
        .where(eq(gameSessions.id, session.id));

      await tx
        .update(sessionPlayers)
        .set({
          state: "TRANSFERRING",
          transferringAt: sql`now()`,
        })
        .where(
          and(
            eq(sessionPlayers.sessionId, session.id),
            eq(sessionPlayers.state, "SELECTED"),
          ),
        );

      const players = (await tx
        .select({ player_id: sessionPlayers.playerId })
        .from(sessionPlayers)
        .where(
          and(
            eq(sessionPlayers.sessionId, session.id),
            ne(sessionPlayers.state, "LEFT"),
          ),
        )) as unknown as { player_id: string }[];

      await this.transfers.enqueue(
        tx,
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

  // Try to fill open pre-start sessions with newly queued parties.
  private async backfill(group: GroupRow): Promise<void> {
    const candidates = (await this.db
      .select({ id: gameSessions.id })
      .from(gameSessions)
      .where(
        and(
          eq(gameSessions.groupId, group.id),
          inArray(gameSessions.state, ["TRANSFERRING", "WAITING"]),
          sql`${gameSessions.waitingDeadline} > now()`,
        ),
      )
      .orderBy(gameSessions.createdAt)) as unknown as { id: string }[];
    // Oldest sessions receive backfill candidates first.
    for (const candidate of candidates) {
      await this.backfillSession(group, candidate.id);
    }
  }

  // Extend one existing assignment without moving players already selected.
  private async backfillSession(
    group: GroupRow,
    sessionId: string,
  ): Promise<boolean> {
    return this.db.transaction(async (tx: any) => {
      // Drizzle ORM does not support "FOR UPDATE OF table" cleanly with joins in builder yet,
      // so we use raw SQL for this precise lock to avoid locking server_instances unnecessarily.
      const sessions = (await tx.execute(sql`
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
      `)) as unknown as {
        id: string;
        instance_id: string;
        endpoint: string;
      }[];
      const session = sessions[0];
      if (!session) return false;

      const existing = (await tx
        .select({
          player_id: sessionPlayers.playerId,
          party_id: sessionPlayers.partyId,
          team_index: sessionPlayers.teamIndex,
        })
        .from(sessionPlayers)
        .where(
          and(
            eq(sessionPlayers.sessionId, session.id),
            ne(sessionPlayers.state, "LEFT"),
          ),
        )
        .orderBy(sessionPlayers.selectedAt)) as unknown as {
        player_id: string;
        party_id: string;
        team_index: number;
      }[];

      if (existing.length >= group.maximum_players) return false;
      const initialTeams = this.toInitialTeams(existing, group.team_count);

      const queue = (await tx.execute(sql`
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
      `)) as unknown as QueueRow[];

      const packed = packParties(
        this.toParties(queue),
        group.team_count,
        group.team_size,
        group.maximum_players,
        initialTeams,
      );
      if (packed.selected.length === 0) return false;
      await this.persistSelection(
        tx,
        session.id,
        packed.teams,
        packed.selected,
        true,
      );

      await tx
        .update(gameSessions)
        .set({
          assignmentRevision: sql`${gameSessions.assignmentRevision} + 1`,
          assignmentAcknowledgedAt: null,
          updatedAt: sql`now()`,
        })
        .where(eq(gameSessions.id, session.id));

      await this.transfers.enqueue(
        tx,
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

  // Move selected queue entries into their durable session team assignments.
  private async persistSelection(
    tx: any,
    sessionId: string,
    teams: readonly TeamAssignment[],
    selected: readonly QueueParty[],
    transferring: boolean,
  ): Promise<void> {
    const selectedIds = new Set(selected.map((party) => party.entryId));
    // Persist team by team so each player receives the exact packing result.
    for (const team of teams) {
      for (const party of team.parties) {
        if (!selectedIds.has(party.entryId)) continue;

        await tx
          .update(queueEntries)
          .set({
            state: "SELECTED",
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(queueEntries.id, party.entryId),
              eq(queueEntries.state, "QUEUED"),
            ),
          );

        for (const playerId of party.playerIds) {
          await tx
            .insert(sessionPlayers)
            .values({
              sessionId: sessionId,
              playerId: playerId,
              partyId: party.partyId,
              teamIndex: team.teamIndex,
              state: transferring ? "TRANSFERRING" : "SELECTED",
              transferringAt: transferring ? sql`now()` : null,
            })
            .onConflictDoNothing({
              target: [sessionPlayers.sessionId, sessionPlayers.playerId],
            });
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

  // Reconstruct team occupancy before attempting a backfill pack.
  private toInitialTeams(
    players: readonly {
      player_id: string;
      party_id: string;
      team_index: number;
    }[],
    teamCount: number,
  ): TeamAssignment[] {
    return Array.from({ length: teamCount }, (_, teamIndex) => {
      const teamPlayers = players.filter(
        (player) => player.team_index === teamIndex,
      );
      const byParty = new Map<string, string[]>();
      // Regroup players by party because the packing algorithm treats parties atomically.
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
      return {
        teamIndex,
        parties,
        playerIds: teamPlayers.map((player) => player.player_id),
      };
    });
  }
}
