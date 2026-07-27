import type postgres from "postgres";
import type { SqlClient } from "../db/client.ts";
import type {
  DashboardClusterSnapshot,
  DashboardGroup,
  DashboardInstance,
  DashboardInstanceDetail,
  DashboardQueueDetail,
  DashboardQueueSummary,
  DashboardSession,
  DashboardSessionDetail,
  DashboardVariant,
} from "../domain/dashboard.ts";
import type {
  AvailabilityState,
  GroupType,
  LifecycleState,
  SessionPlayerState,
  SessionState,
  VariantRuntimeSpec,
} from "../domain/types.ts";

type DatabaseTimestamp = Date | string;

export interface GroupRow {
  id: string;
  type: GroupType;
  enabled: boolean;
  minimum_players: number | null;
  maximum_players: number | null;
  team_count: number | null;
  team_size: number | null;
  waiting_timeout_ms: number | null;
  minimum_instances: number;
  maximum_instances: number;
  minimum_warm_instances: number;
  maximum_warm_instances: number;
  maximum_players_per_instance: number | null;
  target_players_per_instance: number | null;
  startup_timeout_ms: number;
  draining_timeout_ms: number;
  shutdown_timeout_ms: number;
}

export interface VariantRow {
  id: string;
  group_id: string;
  enabled: boolean;
  revision: number;
  selection_weight: number;
  runtime_spec: VariantRuntimeSpec;
}

export interface InstanceRow {
  id: string;
  group_id: string;
  variant_id: string;
  session_id: string | null;
  lifecycle_state: LifecycleState;
  availability_state: AvailabilityState;
  endpoint: string | null;
  player_count: number;
  maximum_players: number;
  created_at: DatabaseTimestamp;
  starting_at: DatabaseTimestamp | null;
  running_at: DatabaseTimestamp | null;
  draining_at: DatabaseTimestamp | null;
  drain_deadline: DatabaseTimestamp | null;
  updated_at: DatabaseTimestamp;
}

export interface SessionRow {
  id: string;
  group_id: string;
  instance_id: string | null;
  state: SessionState;
  assignment_revision: number;
  assignment_acknowledged_at: DatabaseTimestamp | null;
  waiting_deadline: DatabaseTimestamp;
  retry_count: number;
  active_player_count: number;
  connected_player_count: number;
  team_count: number;
  created_at: DatabaseTimestamp;
  started_at: DatabaseTimestamp | null;
  finished_at: DatabaseTimestamp | null;
  updated_at: DatabaseTimestamp;
}

export interface QueueSummaryRow {
  group_id: string;
  party_count: number;
  player_count: number;
  oldest_joined_at: DatabaseTimestamp | null;
}

export interface DashboardRows {
  readonly groups: readonly GroupRow[];
  readonly variants: readonly VariantRow[];
  readonly instances: readonly InstanceRow[];
  readonly sessions: readonly SessionRow[];
  readonly queues: readonly QueueSummaryRow[];
}

function requiredIso(value: DatabaseTimestamp): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}

function iso(value: DatabaseTimestamp | null): string | null {
  return value === null ? null : requiredIso(value);
}

function toVariant(row: VariantRow): DashboardVariant {
  return {
    id: row.id,
    enabled: row.enabled,
    revision: row.revision,
    weight: row.selection_weight,
    runtime: row.runtime_spec,
  };
}

function toInstance(row: InstanceRow): DashboardInstance {
  return {
    id: row.id,
    variantId: row.variant_id,
    sessionId: row.session_id,
    lifecycleState: row.lifecycle_state,
    availabilityState: row.availability_state,
    endpoint: row.endpoint,
    playerCount: row.player_count,
    maximumPlayers: row.maximum_players,
    createdAt: requiredIso(row.created_at),
    startingAt: iso(row.starting_at),
    runningAt: iso(row.running_at),
    drainingAt: iso(row.draining_at),
    drainDeadline: iso(row.drain_deadline),
    updatedAt: requiredIso(row.updated_at),
  };
}

function toSession(row: SessionRow): DashboardSession {
  return {
    id: row.id,
    instanceId: row.instance_id,
    state: row.state,
    assignmentRevision: row.assignment_revision,
    assignmentAcknowledgedAt: iso(row.assignment_acknowledged_at),
    waitingDeadline: requiredIso(row.waiting_deadline),
    retryCount: row.retry_count,
    activePlayerCount: row.active_player_count,
    connectedPlayerCount: row.connected_player_count,
    teamCount: row.team_count,
    createdAt: requiredIso(row.created_at),
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
    updatedAt: requiredIso(row.updated_at),
  };
}

const emptyQueue: DashboardQueueSummary = {
  partyCount: 0,
  playerCount: 0,
  oldestJoinedAt: null,
};

// Assemble normalized database rows into the dashboard cluster graph.
export function assembleClusterSnapshot(
  rows: DashboardRows,
  generatedAt = new Date(),
): DashboardClusterSnapshot {
  const variantsByGroup = new Map<string, DashboardVariant[]>();
  const instancesByGroup = new Map<string, DashboardInstance[]>();
  const sessionsByGroup = new Map<string, DashboardSession[]>();
  const queuesByGroup = new Map<string, DashboardQueueSummary>();

  // Pre-index child rows by group to avoid repeatedly scanning whole result sets.
  for (const variant of rows.variants) {
    const groupVariants = variantsByGroup.get(variant.group_id) ?? [];
    groupVariants.push(toVariant(variant));
    variantsByGroup.set(variant.group_id, groupVariants);
  }
  for (const instance of rows.instances) {
    const groupInstances = instancesByGroup.get(instance.group_id) ?? [];
    groupInstances.push(toInstance(instance));
    instancesByGroup.set(instance.group_id, groupInstances);
  }
  for (const session of rows.sessions) {
    const groupSessions = sessionsByGroup.get(session.group_id) ?? [];
    groupSessions.push(toSession(session));
    sessionsByGroup.set(session.group_id, groupSessions);
  }
  for (const queue of rows.queues) {
    queuesByGroup.set(queue.group_id, {
      partyCount: queue.party_count,
      playerCount: queue.player_count,
      oldestJoinedAt: iso(queue.oldest_joined_at),
    });
  }

  // Build each group from its indexed children and derive operational counters in one pass.
  const groups: DashboardGroup[] = rows.groups.map((group) => {
    const instances = instancesByGroup.get(group.id) ?? [];
    // STOPPED and FAILED rows remain useful historically but do not consume active capacity.
    const activeInstances = instances.filter(
      (instance) =>
        instance.lifecycleState !== "STOPPED" && instance.lifecycleState !== "FAILED",
    );
    const warmInstances = activeInstances.filter(
      (instance) =>
        instance.lifecycleState === "RUNNING" && instance.availabilityState === "OPEN",
    ).length;
    const pendingWarmInstances = activeInstances.filter(
      (instance) =>
        (instance.lifecycleState === "CREATING" ||
          instance.lifecycleState === "STARTING") &&
        instance.availabilityState === "OPEN",
    ).length;
    const reservedInstances = activeInstances.filter(
      (instance) => instance.availabilityState === "RESERVED",
    ).length;
    return {
      id: group.id,
      type: group.type,
      enabled: group.enabled,
      capacity: {
        minimumInstances: group.minimum_instances,
        maximumInstances: group.maximum_instances,
        minimumWarmInstances: group.minimum_warm_instances,
        maximumWarmInstances: group.maximum_warm_instances,
        activeInstances: activeInstances.length,
        warmInstances,
        pendingWarmInstances,
        reservedInstances,
      },
      lifecycle: {
        startupTimeoutMs: group.startup_timeout_ms,
        drainingTimeoutMs: group.draining_timeout_ms,
        shutdownTimeoutMs: group.shutdown_timeout_ms,
      },
      matchmaking:
        group.type === "minigame" &&
        group.minimum_players !== null &&
        group.maximum_players !== null &&
        group.team_count !== null &&
        group.team_size !== null &&
        group.waiting_timeout_ms !== null
          ? {
              minimumPlayers: group.minimum_players,
              maximumPlayers: group.maximum_players,
              teamCount: group.team_count,
              teamSize: group.team_size,
              waitingTimeoutMs: group.waiting_timeout_ms,
            }
          : null,
      routing:
        group.type === "hub" &&
        group.maximum_players_per_instance !== null &&
        group.target_players_per_instance !== null
          ? {
              maximumPlayersPerInstance: group.maximum_players_per_instance,
              targetPlayersPerInstance: group.target_players_per_instance,
            }
          : null,
      queue: queuesByGroup.get(group.id) ?? emptyQueue,
      variants: variantsByGroup.get(group.id) ?? [],
      instances,
      sessions: sessionsByGroup.get(group.id) ?? [],
    };
  });

  // Flatten only after group construction so global summary values reuse group-derived data.
  const allInstances = groups.flatMap((group) => group.instances);
  const allSessions = groups.flatMap((group) => group.sessions);
  return {
    schemaVersion: 1,
    generatedAt: generatedAt.toISOString(),
    summary: {
      enabledGroups: groups.filter((group) => group.enabled).length,
      activeInstances: groups.reduce(
        (total, group) => total + group.capacity.activeInstances,
        0,
      ),
      runningInstances: allInstances.filter(
        (instance) => instance.lifecycleState === "RUNNING",
      ).length,
      warmInstances: groups.reduce(
        (total, group) => total + group.capacity.warmInstances,
        0,
      ),
      pendingWarmInstances: groups.reduce(
        (total, group) => total + group.capacity.pendingWarmInstances,
        0,
      ),
      reservedInstances: groups.reduce(
        (total, group) => total + group.capacity.reservedInstances,
        0,
      ),
      playersOnline: allInstances.reduce(
        (total, instance) => total + instance.playerCount,
        0,
      ),
      activeSessions: allSessions.filter(
        (session) =>
          session.state !== "FINISHED" &&
          session.state !== "CANCELLED" &&
          session.state !== "FAILED",
      ).length,
      queuedParties: groups.reduce(
        (total, group) => total + group.queue.partyCount,
        0,
      ),
      queuedPlayers: groups.reduce(
        (total, group) => total + group.queue.playerCount,
        0,
      ),
    },
    groups,
  };
}

// Clamp dashboard pagination limits to a safe range.
export function normalizeDashboardLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) return 50;
  return Math.max(1, Math.min(200, Math.trunc(value ?? 50)));
}

export class DashboardService {
  public constructor(private readonly sql: SqlClient) {}

  // Return the complete cluster snapshot consumed by the dashboard.
  public async getCluster(): Promise<DashboardClusterSnapshot> {
    const rows = await this.sql.begin(
      "read only isolation level repeatable read",
      async (transaction) => this.readClusterRows(transaction),
    );
    return assembleClusterSnapshot(rows);
  }

  // Return a bounded queue view with parties and player membership.
  public async getQueue(
    groupId: string,
    requestedLimit?: number,
  ): Promise<DashboardQueueDetail | null> {
    const limit = normalizeDashboardLimit(requestedLimit);
    // Repeatable-read keeps totals and paginated entries from describing different queue moments.
    return this.sql.begin("read only isolation level repeatable read", async (transaction) => {
      const groups = await transaction<{ id: string }[]>`
        SELECT id FROM server_groups WHERE id = ${groupId}
      `;
      if (!groups[0]) return null;
      const totals = await transaction<{ party_count: number; player_count: number }[]>`
        SELECT
          count(DISTINCT q.id)::int AS party_count,
          count(qp.player_id)::int AS player_count
        FROM queue_entries q
        LEFT JOIN queue_entry_players qp ON qp.queue_entry_id = q.id
        WHERE q.group_id = ${groupId} AND q.state = 'QUEUED'
      `;
      const entries = await transaction<
        {
          id: string;
          party_id: string;
          joined_at: DatabaseTimestamp;
          players: string[];
        }[]
      >`
        SELECT
          q.id, q.party_id, q.joined_at,
          coalesce(
            array_agg(qp.player_id::text ORDER BY qp.player_id)
              FILTER (WHERE qp.player_id IS NOT NULL),
            ARRAY[]::text[]
          ) AS players
        FROM queue_entries q
        LEFT JOIN queue_entry_players qp ON qp.queue_entry_id = q.id
        WHERE q.group_id = ${groupId} AND q.state = 'QUEUED'
        GROUP BY q.id
        ORDER BY q.joined_at, q.id
        LIMIT ${limit}
      `;
      const totalParties = totals[0]?.party_count ?? 0;
      return {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        groupId,
        totalParties,
        totalPlayers: totals[0]?.player_count ?? 0,
        truncated: totalParties > entries.length,
        entries: entries.map((entry) => ({
          id: entry.id,
          partyId: entry.party_id,
          joinedAt: requiredIso(entry.joined_at),
          players: entry.players,
        })),
      };
    });
  }

  // Load one instance together with its runtime, session, and event details.
  public async getInstance(instanceId: string): Promise<DashboardInstanceDetail | null> {
    return this.sql.begin("read only isolation level repeatable read", async (transaction) => {
      const instances = await transaction<
        (InstanceRow & {
          group_type: GroupType;
          container_id: string | null;
          runtime_path: string | null;
          stopped_at: DatabaseTimestamp | null;
          checksum: string;
          variant_enabled: boolean;
          revision: number;
          selection_weight: number;
          runtime_spec: VariantRuntimeSpec;
        })[]
      >`
        SELECT
          i.id, i.group_id, i.variant_id, i.session_id, i.lifecycle_state,
          i.availability_state, i.endpoint, i.player_count,
          coalesce(g.maximum_players_per_instance, g.maximum_players, 0)::int
            AS maximum_players,
          i.container_id, i.runtime_path, i.created_at, i.starting_at, i.running_at,
          i.draining_at, i.drain_deadline, i.stopped_at, i.updated_at,
          g.type AS group_type, v.enabled AS variant_enabled, v.revision,
          v.selection_weight, v.runtime_spec, v.checksum
        FROM server_instances i
        JOIN server_groups g ON g.id = i.group_id
        JOIN server_variants v ON v.id = i.variant_id
        WHERE i.id = ${instanceId}
      `;
      const instance = instances[0];
      if (!instance) return null;
      // Detail collections are independent and can be fetched concurrently inside one snapshot.
      const [players, commands, events, sessions] = await Promise.all([
        transaction<
          {
            player_id: string;
            connected_at: DatabaseTimestamp;
            last_seen_at: DatabaseTimestamp;
          }[]
        >`
          SELECT player_id, connected_at, last_seen_at
          FROM instance_players
          WHERE instance_id = ${instanceId}
          ORDER BY connected_at
        `,
        transaction<
          {
            id: string;
            operation: string;
            state: string;
            attempts: number;
            payload: unknown;
            last_error: string | null;
            created_at: DatabaseTimestamp;
            completed_at: DatabaseTimestamp | null;
          }[]
        >`
          SELECT id, operation, state, attempts, payload, last_error, created_at, completed_at
          FROM commands
          WHERE instance_id = ${instanceId}
          ORDER BY created_at DESC
          LIMIT 20
        `,
        transaction<
          {
            id: string;
            type: string;
            payload: unknown;
            created_at: DatabaseTimestamp;
          }[]
        >`
          SELECT id, type, payload, created_at
          FROM events
          WHERE aggregate_type = 'instance' AND aggregate_id = ${instanceId}
          ORDER BY created_at DESC
          LIMIT 20
        `,
        instance.session_id
          ? this.readSessionRows(transaction, instance.session_id)
          : Promise.resolve([]),
      ]);
      return {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        instance: {
          ...toInstance(instance),
          groupId: instance.group_id,
          groupType: instance.group_type,
          containerId: instance.container_id,
          runtimePath: instance.runtime_path,
          stoppedAt: iso(instance.stopped_at),
        },
        variant: {
          id: instance.variant_id,
          enabled: instance.variant_enabled,
          revision: instance.revision,
          weight: instance.selection_weight,
          runtime: instance.runtime_spec,
          checksum: instance.checksum,
        },
        players: players.map((player) => ({
          playerId: player.player_id,
          connectedAt: requiredIso(player.connected_at),
          lastSeenAt: requiredIso(player.last_seen_at),
        })),
        session: sessions[0] ? toSession(sessions[0]) : null,
        commands: commands.map((command) => ({
          id: command.id,
          operation: command.operation,
          state: command.state,
          attempts: command.attempts,
          payload: command.payload,
          lastError: command.last_error,
          createdAt: requiredIso(command.created_at),
          completedAt: iso(command.completed_at),
        })),
        events: events.map((event) => ({
          id: event.id,
          type: event.type,
          payload: event.payload,
          createdAt: requiredIso(event.created_at),
        })),
      };
    });
  }

  // Load one session together with its assignment and transfer history.
  public async getSession(sessionId: string): Promise<DashboardSessionDetail | null> {
    return this.sql.begin("read only isolation level repeatable read", async (transaction) => {
      const sessions = await this.readSessionRows(transaction, sessionId);
      const session = sessions[0];
      if (!session) return null;
      // Assignment and transfer history share the same repeatable-read snapshot.
      const [players, transfers] = await Promise.all([
        transaction<
          {
            player_id: string;
            party_id: string;
            team_index: number;
            state: SessionPlayerState;
            selected_at: DatabaseTimestamp;
            transferring_at: DatabaseTimestamp | null;
            connected_at: DatabaseTimestamp | null;
            left_at: DatabaseTimestamp | null;
          }[]
        >`
          SELECT player_id, party_id, team_index, state, selected_at,
                 transferring_at, connected_at, left_at
          FROM session_players
          WHERE session_id = ${sessionId}
          ORDER BY team_index, selected_at, player_id
        `,
        transaction<
          {
            id: string;
            instance_id: string;
            state: string;
            attempts: number;
            next_attempt_at: DatabaseTimestamp;
            expires_at: DatabaseTimestamp;
            created_at: DatabaseTimestamp;
            completed_at: DatabaseTimestamp | null;
          }[]
        >`
          SELECT id, instance_id, state, attempts, next_attempt_at,
                 expires_at, created_at, completed_at
          FROM transfer_commands
          WHERE session_id = ${sessionId}
          ORDER BY created_at DESC
          LIMIT 20
        `,
      ]);
      const byTeam = new Map<number, (DashboardSessionDetail["teams"][number]["players"][number])[]>();
      // Regroup flat SQL rows into the team-oriented API shape expected by the dashboard.
      for (const player of players) {
        const team = byTeam.get(player.team_index) ?? [];
        team.push({
          playerId: player.player_id,
          partyId: player.party_id,
          state: player.state,
          selectedAt: requiredIso(player.selected_at),
          transferringAt: iso(player.transferring_at),
          connectedAt: iso(player.connected_at),
          leftAt: iso(player.left_at),
        });
        byTeam.set(player.team_index, team);
      }
      return {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        session: { ...toSession(session), groupId: session.group_id },
        // Sort numeric team indexes because Map insertion order follows query rows, not the API contract.
        teams: [...byTeam.entries()]
          .sort(([left], [right]) => left - right)
          .map(([teamIndex, teamPlayers]) => ({ teamIndex, players: teamPlayers })),
        transfers: transfers.map((transfer) => ({
          id: transfer.id,
          instanceId: transfer.instance_id,
          state: transfer.state,
          attempts: transfer.attempts,
          nextAttemptAt: requiredIso(transfer.next_attempt_at),
          expiresAt: requiredIso(transfer.expires_at),
          createdAt: requiredIso(transfer.created_at),
          completedAt: iso(transfer.completed_at),
        })),
      };
    });
  }

  // Fetch the row sets needed to build a consistent cluster snapshot.
  private async readClusterRows(
    transaction: postgres.TransactionSql,
  ): Promise<DashboardRows> {
    const groups = await transaction<GroupRow[]>`
      SELECT id, type, enabled, minimum_players, maximum_players, team_count, team_size,
             waiting_timeout_ms, minimum_instances, maximum_instances,
             minimum_warm_instances, maximum_warm_instances,
             maximum_players_per_instance, target_players_per_instance,
             startup_timeout_ms, draining_timeout_ms, shutdown_timeout_ms
      FROM server_groups
      ORDER BY type, id
    `;
    const variants = await transaction<VariantRow[]>`
      SELECT id, group_id, enabled, revision, selection_weight, runtime_spec
      FROM server_variants
      ORDER BY group_id, id
    `;
    const instances = await transaction<InstanceRow[]>`
      SELECT
        i.id, i.group_id, i.variant_id, i.session_id, i.lifecycle_state,
        i.availability_state, i.endpoint, i.player_count,
        coalesce(g.maximum_players_per_instance, g.maximum_players, 0)::int
          AS maximum_players,
        i.created_at, i.starting_at, i.running_at, i.draining_at,
        i.drain_deadline, i.updated_at
      FROM server_instances i
      JOIN server_groups g ON g.id = i.group_id
      WHERE i.lifecycle_state <> 'STOPPED'
      ORDER BY i.group_id, i.created_at, i.id
    `;
    const sessions = await transaction<SessionRow[]>`
      SELECT
        s.id, s.group_id, s.instance_id, s.state, s.assignment_revision,
        s.assignment_acknowledged_at, s.waiting_deadline, s.retry_count,
        count(sp.player_id) FILTER (WHERE sp.state <> 'LEFT')::int AS active_player_count,
        count(sp.player_id) FILTER (WHERE sp.state = 'CONNECTED')::int AS connected_player_count,
        count(DISTINCT sp.team_index) FILTER (WHERE sp.state <> 'LEFT')::int AS team_count,
        s.created_at, s.started_at, s.finished_at, s.updated_at
      FROM game_sessions s
      LEFT JOIN session_players sp ON sp.session_id = s.id
      WHERE s.state NOT IN ('FINISHED', 'CANCELLED', 'FAILED')
         OR EXISTS (
           SELECT 1 FROM server_instances i
           WHERE i.session_id = s.id AND i.lifecycle_state <> 'STOPPED'
         )
      GROUP BY s.id
      ORDER BY s.group_id, s.created_at, s.id
    `;
    const queues = await transaction<QueueSummaryRow[]>`
      SELECT
        q.group_id,
        count(DISTINCT q.id)::int AS party_count,
        count(qp.player_id)::int AS player_count,
        min(q.joined_at) AS oldest_joined_at
      FROM queue_entries q
      LEFT JOIN queue_entry_players qp ON qp.queue_entry_id = q.id
      WHERE q.state = 'QUEUED'
      GROUP BY q.group_id
    `;
    return { groups, variants, instances, sessions, queues };
  }

  // Fetch session summaries shared by cluster and detail endpoints.
  private async readSessionRows(
    transaction: postgres.TransactionSql,
    sessionId: string,
  ): Promise<SessionRow[]> {
    return transaction<SessionRow[]>`
      SELECT
        s.id, s.group_id, s.instance_id, s.state, s.assignment_revision,
        s.assignment_acknowledged_at, s.waiting_deadline, s.retry_count,
        count(sp.player_id) FILTER (WHERE sp.state <> 'LEFT')::int AS active_player_count,
        count(sp.player_id) FILTER (WHERE sp.state = 'CONNECTED')::int AS connected_player_count,
        count(DISTINCT sp.team_index) FILTER (WHERE sp.state <> 'LEFT')::int AS team_count,
        s.created_at, s.started_at, s.finished_at, s.updated_at
      FROM game_sessions s
      LEFT JOIN session_players sp ON sp.session_id = s.id
      WHERE s.id = ${sessionId}
      GROUP BY s.id
    `;
  }
}
