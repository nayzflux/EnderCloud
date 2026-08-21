import { and, asc, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import {
  gameSessions,
  queueEntries,
  queueEntryPlayers,
  serverGroups,
  serverInstances,
  executionHosts,
  sessionPlayers,
} from "../db/schema.ts";
import {
  computeFeasibleProfiles,
  isProfileEligible,
  rankSessionCandidates,
  selectRecommendedProfile,
} from "../domain/matchmaking.ts";
import type { QueueParty, SessionState } from "../domain/types.ts";
import { nanoid } from "../id.ts";
import type { Logger } from "../logger.ts";
import type { TransferService } from "./transfer-service.ts";

interface GroupRow {
  id: string;
  minimumPlayers: number;
  maximumPlayers: number;
  teamCount: number;
  teamSize: number;
  candidateWindow: number;
  instanceAcquisitionTimeoutMs: number;
  lobbyStaleTimeoutMs: number;
  transferTimeoutMs: number;
  minimumPlayersPerTeam: number;
  maximumTeamSpread: number;
}

interface SessionCandidate {
  id: string;
  state: Extract<
    SessionState,
    "FORMING" | "WAITING_FOR_INSTANCE" | "TRANSFERRING" | "WAITING"
  >;
  instanceId: string | null;
  endpoint: string | null;
  createdAt: Date;
  ticketSizes: number[];
  instanceAcquisitionDeadline: Date | null;
  lobbyStaleDeadline: Date | null;
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

  public async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const groups = await this.db
        .select({
          id: serverGroups.id,
          minimumPlayers: serverGroups.minimumPlayers,
          maximumPlayers: serverGroups.maximumPlayers,
          teamCount: serverGroups.teamCount,
          teamSize: serverGroups.teamSize,
          candidateWindow: serverGroups.candidateWindow,
          instanceAcquisitionTimeoutMs: serverGroups.instanceAcquisitionTimeoutMs,
          lobbyStaleTimeoutMs: serverGroups.lobbyStaleTimeoutMs,
          transferTimeoutMs: serverGroups.transferTimeoutMs,
          minimumPlayersPerTeam: serverGroups.minimumPlayersPerTeam,
          maximumTeamSpread: serverGroups.maximumTeamSpread,
        })
        .from(serverGroups)
        .where(
          and(
            eq(serverGroups.type, "minigame"),
            eq(serverGroups.enabled, true),
            isNotNull(serverGroups.minimumPlayers),
          ),
        );

      for (const raw of groups) {
        const group = this.normalizeGroup(raw);
        if (!group) continue;
        try {
          await this.processGroup(group);
        } catch (error) {
          this.logger.error("Matchmaking group tick failed", {
            groupId: group.id,
            error: String(error),
          });
        }
      }
    } catch (error) {
      this.logger.error("Matchmaking tick failed", { error: String(error) });
      throw error;
    } finally {
      this.running = false;
    }
  }

  // One PostgreSQL advisory lock serializes every logical worker for this mode.
  private async processGroup(group: GroupRow): Promise<void> {
    await this.db.transaction(async (tx: any) => {
      const locks = (await tx.execute(sql`
        SELECT pg_try_advisory_xact_lock(hashtextextended(${group.id}, 0)) AS locked
      `)) as unknown as { locked: boolean }[];
      if (!locks[0]?.locked) return;

      const sessions = (await this.loadSessions(tx, group.id)).filter((session) =>
        this.acceptsTicketsBeforeStaleDeadline(session)
      );
      // Capacity is assigned before queue placement so a waiting session resumes promptly.
      for (const session of sessions) {
        if (session.state === "WAITING_FOR_INSTANCE") {
          if (this.isExpectedStartEligible(session, group)) {
            await this.tryAssignInstance(tx, group, session);
          } else {
            session.state = "FORMING";
            session.instanceAcquisitionDeadline = null;
            await tx.update(gameSessions)
              .set({
                state: "FORMING",
                instanceAcquisitionDeadline: null,
                lobbyStaleDeadline: null,
                updatedAt: sql`now()`,
              })
              .where(
                and(
                  eq(gameSessions.id, session.id),
                  eq(gameSessions.state, "WAITING_FOR_INSTANCE"),
                ),
              );
          }
        }
      }

      const queue = (await tx.execute(sql`
        WITH locked_entries AS (
          SELECT q.id, q.party_id, q.joined_at
          FROM queue_entries q
          WHERE q.group_id = ${group.id} AND q.state = 'QUEUED'
          ORDER BY q.joined_at, q.id
          LIMIT ${group.candidateWindow}
          FOR UPDATE SKIP LOCKED
        )
        SELECT q.id AS entry_id, q.party_id, q.joined_at,
               array_agg(qp.player_id ORDER BY qp.player_id)::text[] AS player_ids
        FROM locked_entries q
        JOIN queue_entry_players qp ON qp.queue_entry_id = q.id
        GROUP BY q.id, q.party_id, q.joined_at
        ORDER BY q.joined_at, q.id
      `)) as unknown as QueueRow[];

      for (const party of this.toParties(queue)) {
        let session = this.chooseSession(sessions, party, group);
        if (!session) {
          session = {
            id: nanoid(),
            state: "FORMING",
            instanceId: null,
            endpoint: null,
            createdAt: new Date(),
            ticketSizes: [],
            instanceAcquisitionDeadline: null,
            lobbyStaleDeadline: null,
          };
          await tx.insert(gameSessions).values({
            id: session.id,
            groupId: group.id,
            state: "FORMING",
            instanceAcquisitionDeadline: null,
            lobbyStaleDeadline: null,
          });
          sessions.push(session);
        }

        await this.attachParty(tx, session, party);
        session.ticketSizes.push(party.playerIds.length);

        if (session.instanceId && session.endpoint) {
          await this.beginTicketTransfer(tx, session, party);
        } else if (
          session.state === "FORMING" &&
          this.isExpectedStartEligible(session, group)
        ) {
          await this.dispatchSession(tx, group, session);
        }
      }
    });
  }

  private normalizeGroup(raw: {
    id: string;
    minimumPlayers: number | null;
    maximumPlayers: number | null;
    teamCount: number | null;
    teamSize: number | null;
    candidateWindow: number | null;
    instanceAcquisitionTimeoutMs: number | null;
    lobbyStaleTimeoutMs: number | null;
    transferTimeoutMs: number;
    minimumPlayersPerTeam: number | null;
    maximumTeamSpread: number | null;
  }): GroupRow | null {
    if (
      raw.minimumPlayers == null ||
      raw.maximumPlayers == null ||
      raw.teamCount == null ||
      raw.teamSize == null ||
      raw.instanceAcquisitionTimeoutMs == null ||
      raw.lobbyStaleTimeoutMs == null
    ) {
      this.logger.error("Skipping minigame group with incomplete policy", {
        groupId: raw.id,
      });
      return null;
    }
    return {
      id: raw.id,
      minimumPlayers: raw.minimumPlayers,
      maximumPlayers: raw.maximumPlayers,
      teamCount: raw.teamCount,
      teamSize: raw.teamSize,
      candidateWindow: raw.candidateWindow ?? 20,
      instanceAcquisitionTimeoutMs: raw.instanceAcquisitionTimeoutMs,
      lobbyStaleTimeoutMs: raw.lobbyStaleTimeoutMs,
      transferTimeoutMs: raw.transferTimeoutMs,
      minimumPlayersPerTeam: raw.minimumPlayersPerTeam ?? 0,
      maximumTeamSpread: raw.maximumTeamSpread ?? raw.teamSize,
    };
  }

  private async loadSessions(tx: any, groupId: string): Promise<SessionCandidate[]> {
    const rows = (await tx
      .select({
        id: gameSessions.id,
        state: gameSessions.state,
        instance_id: gameSessions.instanceId,
        endpoint: serverInstances.endpoint,
        created_at: gameSessions.createdAt,
        instance_acquisition_deadline: gameSessions.instanceAcquisitionDeadline,
        lobby_stale_deadline: gameSessions.lobbyStaleDeadline,
      })
      .from(gameSessions)
      .leftJoin(serverInstances, eq(serverInstances.id, gameSessions.instanceId))
      .where(
        and(
          eq(gameSessions.groupId, groupId),
          inArray(gameSessions.state, [
            "FORMING",
            "WAITING_FOR_INSTANCE",
            "TRANSFERRING",
            "WAITING",
          ]),
        ),
      )
      .orderBy(asc(gameSessions.createdAt), asc(gameSessions.id))
      .for("update", { of: gameSessions })) as unknown as {
      id: string;
      state: SessionCandidate["state"];
      instance_id: string | null;
      endpoint: string | null;
      created_at: Date;
      instance_acquisition_deadline: Date | null;
      lobby_stale_deadline: Date | null;
    }[];
    const sizes = rows.length === 0
      ? []
      : (await tx
          .select({
            session_id: sessionPlayers.sessionId,
            ticket_id: sql<string>`COALESCE(${sessionPlayers.queueEntryId}, 'legacy:' || ${sessionPlayers.partyId})`,
            player_count: sql<number>`count(*)::integer`,
          })
          .from(sessionPlayers)
          .where(
            and(
              inArray(sessionPlayers.sessionId, rows.map((row) => row.id)),
              ne(sessionPlayers.state, "LEFT"),
            ),
          )
          .groupBy(
            sessionPlayers.sessionId,
            sql`COALESCE(${sessionPlayers.queueEntryId}, 'legacy:' || ${sessionPlayers.partyId})`,
          )
          .orderBy(asc(sessionPlayers.sessionId))) as unknown as {
            session_id: string;
            ticket_id: string;
            player_count: number;
          }[];
    return rows.map((row) => ({
      id: row.id,
      state: row.state,
      instanceId: row.instance_id,
      endpoint: row.endpoint,
      createdAt: new Date(row.created_at),
      ticketSizes: sizes
        .filter((size) => size.session_id === row.id)
        .map((size) => Number(size.player_count)),
      instanceAcquisitionDeadline: row.instance_acquisition_deadline
        ? new Date(row.instance_acquisition_deadline)
        : null,
      lobbyStaleDeadline: row.lobby_stale_deadline
        ? new Date(row.lobby_stale_deadline)
        : null,
    }));
  }

  private acceptsTicketsBeforeStaleDeadline(session: SessionCandidate): boolean {
    return (
      !session.lobbyStaleDeadline ||
      session.lobbyStaleDeadline.getTime() > Date.now()
    );
  }

  private chooseSession(
    sessions: readonly SessionCandidate[],
    party: QueueParty,
    group: GroupRow,
  ): SessionCandidate | undefined {
    const ranked = rankSessionCandidates(
      sessions.map((session) => ({
        sessionId: session.id,
        createdAt: session.createdAt,
        ticketSizes: session.ticketSizes,
      })),
      party.playerIds.length,
      group.teamCount,
      group.teamSize,
      group.maximumPlayers,
    );
    const selectedId = ranked[0]?.sessionId;
    return sessions.find((session) => session.id === selectedId);
  }

  private async attachParty(
    tx: any,
    session: SessionCandidate,
    party: QueueParty,
  ): Promise<void> {
    const updated = await tx
      .update(queueEntries)
      .set({
        state: "SELECTED",
        sessionId: session.id,
        updatedAt: sql`now()`,
      })
      .where(
        and(eq(queueEntries.id, party.entryId), eq(queueEntries.state, "QUEUED")),
      )
      .returning({ id: queueEntries.id });
    if (updated.length === 0) return;

    for (const playerId of party.playerIds) {
      const inserted = await tx.insert(sessionPlayers).values({
        sessionId: session.id,
        playerId,
        partyId: party.partyId,
        queueEntryId: party.entryId,
        state: "SELECTED",
      }).onConflictDoNothing({
        target: [sessionPlayers.sessionId, sessionPlayers.playerId],
      }).returning({ playerId: sessionPlayers.playerId });
      if (inserted.length === 0) {
        const reactivated = await tx.update(sessionPlayers)
          .set({
            partyId: party.partyId,
            queueEntryId: party.entryId,
            state: "SELECTED",
            selectedAt: sql`now()`,
            transferringAt: null,
            connectedAt: null,
            leftAt: null,
          })
          .where(
            and(
              eq(sessionPlayers.sessionId, session.id),
              eq(sessionPlayers.playerId, playerId),
              eq(sessionPlayers.state, "LEFT"),
            ),
          )
          .returning({ playerId: sessionPlayers.playerId });
        if (reactivated.length === 0) {
          throw new Error(`Player ${playerId} is already active in session ${session.id}`);
        }
      }
    }
    await tx.update(gameSessions)
      .set({
        assignmentRevision: sql`${gameSessions.assignmentRevision} + 1`,
        assignmentAcknowledgedAt: null,
        updatedAt: sql`now()`,
      })
      .where(eq(gameSessions.id, session.id));
  }

  private isExpectedStartEligible(
    session: SessionCandidate,
    group: GroupRow,
  ): boolean {
    const playerCount = session.ticketSizes.reduce((sum, size) => sum + size, 0);
    if (playerCount < group.minimumPlayers) return false;
    const profiles = computeFeasibleProfiles(
      session.ticketSizes,
      group.teamCount,
      group.teamSize,
    );
    return isProfileEligible(
      selectRecommendedProfile(profiles),
      group.minimumPlayersPerTeam,
      group.maximumTeamSpread,
    );
  }

  private async dispatchSession(
    tx: any,
    group: GroupRow,
    session: SessionCandidate,
  ): Promise<void> {
    const reservation = await this.reserveInstance(tx, group.id, session.id);
    if (!reservation) {
      session.state = "WAITING_FOR_INSTANCE";
      await tx.update(gameSessions)
        .set({
          state: "WAITING_FOR_INSTANCE",
          instanceAcquisitionDeadline:
            sql`now() + (${group.instanceAcquisitionTimeoutMs} * interval '1 millisecond')`,
          lobbyStaleDeadline: null,
          updatedAt: sql`now()`,
        })
        .where(and(eq(gameSessions.id, session.id), eq(gameSessions.state, "FORMING")));
      return;
    }
    session.instanceId = reservation.id;
    session.endpoint = reservation.endpoint;
    session.state = "TRANSFERRING";
    await this.startSessionTransfers(tx, group, session, reservation);
  }

  private async tryAssignInstance(
    tx: any,
    group: GroupRow,
    session: SessionCandidate,
  ): Promise<boolean> {
    const reservation = await this.reserveInstance(tx, group.id, session.id);
    if (!reservation) return false;
    session.instanceId = reservation.id;
    session.endpoint = reservation.endpoint;
    session.state = "TRANSFERRING";
    await this.startSessionTransfers(tx, group, session, reservation);
    return true;
  }

  private async reserveInstance(
    tx: any,
    groupId: string,
    sessionId: string,
  ): Promise<Reservation | null> {
    const reservations = (await tx
      .select({ id: serverInstances.id, endpoint: serverInstances.endpoint })
      .from(serverInstances)
      .innerJoin(executionHosts, eq(executionHosts.id, serverInstances.hostId))
      .where(
        and(
          eq(serverInstances.groupId, groupId),
          eq(serverInstances.lifecycleState, "RUNNING"),
          eq(serverInstances.availabilityState, "OPEN"),
          eq(executionHosts.healthState, "ONLINE"),
          eq(executionHosts.adminState, "ACTIVE"),
          isNotNull(serverInstances.endpoint),
        ),
      )
      .orderBy(asc(serverInstances.runningAt), asc(serverInstances.id))
      .limit(1)
      .for("update", { skipLocked: true })) as unknown as Reservation[];
    const reservation = reservations[0];
    if (!reservation) return null;
    const claimed = await tx.update(serverInstances)
      .set({
        availabilityState: "RESERVED",
        sessionId,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(serverInstances.id, reservation.id),
          eq(serverInstances.availabilityState, "OPEN"),
          eq(serverInstances.lifecycleState, "RUNNING"),
        ),
      )
      .returning({ id: serverInstances.id });
    return claimed.length > 0 ? reservation : null;
  }

  private async startSessionTransfers(
    tx: any,
    group: GroupRow,
    session: SessionCandidate,
    reservation: Reservation,
  ): Promise<void> {
    await tx.update(gameSessions)
      .set({
        instanceId: reservation.id,
        state: "TRANSFERRING",
        transferStartedAt: sql`now()`,
        instanceAcquisitionDeadline: null,
        lobbyStaleDeadline:
          sql`now() + (${group.lobbyStaleTimeoutMs} * interval '1 millisecond')`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(gameSessions.id, session.id),
          inArray(gameSessions.state, ["FORMING", "WAITING_FOR_INSTANCE"]),
        ),
      );
    await tx.update(queueEntries)
      .set({ transferStartedAt: sql`now()`, updatedAt: sql`now()` })
      .where(
        and(
          eq(queueEntries.sessionId, session.id),
          eq(queueEntries.state, "SELECTED"),
          sql`${queueEntries.transferStartedAt} IS NULL`,
        ),
      );
    await tx.update(sessionPlayers)
      .set({
        state: "TRANSFERRING",
        transferringAt: sql`now()`,
        transferDeadline:
          sql`now() + (${group.transferTimeoutMs} * interval '1 millisecond')`,
      })
      .where(
        and(
          eq(sessionPlayers.sessionId, session.id),
          eq(sessionPlayers.state, "SELECTED"),
        ),
      );
    const players = await tx.select({ playerId: sessionPlayers.playerId })
      .from(sessionPlayers)
      .where(
        and(
          eq(sessionPlayers.sessionId, session.id),
          ne(sessionPlayers.state, "LEFT"),
        ),
      );
    if (players.length > 0) {
      await this.transfers.enqueue(
        tx,
        {
          instanceId: reservation.id,
          endpoint: reservation.endpoint,
          players: players.map((player: { playerId: string }) => player.playerId),
        },
        session.id,
      );
    }
  }

  private async beginTicketTransfer(
    tx: any,
    session: SessionCandidate,
    party: QueueParty,
  ): Promise<void> {
    if (!session.instanceId || !session.endpoint) return;
    await tx.update(queueEntries)
      .set({ transferStartedAt: sql`now()`, updatedAt: sql`now()` })
      .where(eq(queueEntries.id, party.entryId));
    const timeout = await tx.select({ transferTimeoutMs: serverGroups.transferTimeoutMs })
      .from(serverGroups)
      .innerJoin(gameSessions, eq(gameSessions.groupId, serverGroups.id))
      .where(eq(gameSessions.id, session.id))
      .limit(1);
    if (!timeout[0]) throw new Error(`Session ${session.id} has no timeout policy`);
    await tx.update(sessionPlayers)
      .set({
        state: "TRANSFERRING",
        transferringAt: sql`now()`,
        transferDeadline:
          sql`now() + (${timeout[0].transferTimeoutMs} * interval '1 millisecond')`,
      })
      .where(
        and(
          eq(sessionPlayers.sessionId, session.id),
          eq(sessionPlayers.partyId, party.partyId),
          eq(sessionPlayers.state, "SELECTED"),
        ),
      );
    await this.transfers.enqueue(
      tx,
      {
        instanceId: session.instanceId,
        endpoint: session.endpoint,
        players: party.playerIds,
      },
      session.id,
    );
  }

  private toParties(rows: readonly QueueRow[]): QueueParty[] {
    return rows.map((row) => ({
      entryId: row.entry_id,
      partyId: row.party_id,
      joinedAt: new Date(row.joined_at),
      playerIds: row.player_ids,
    }));
  }
}
