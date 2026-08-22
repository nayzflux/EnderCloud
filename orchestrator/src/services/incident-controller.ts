import { and, desc, eq, inArray, lt, ne, or, sql } from "drizzle-orm";
import type { AppConfig } from "../config.ts";
import type { Database } from "../db/client.ts";
import { operationalIncidents } from "../db/schema.ts";
import type { DashboardIncidentPage } from "../domain/dashboard.ts";
import type {
  IncidentKind,
  IncidentScopeType,
  IncidentSeverity,
} from "../domain/types.ts";
import { nanoid } from "../id.ts";
import type { Logger } from "../logger.ts";

type DatabaseTimestamp = Date | string;

interface Observation {
  readonly fingerprint: string;
  readonly kind: IncidentKind;
  readonly severity: IncidentSeverity;
  readonly scopeType: IncidentScopeType;
  readonly scopeId: string;
  readonly groupId?: string;
  readonly variantId?: string;
  readonly summary: string;
  readonly cause: string;
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly openAfterMs?: number;
  readonly occurrenceCount?: number;
  readonly openAfterOccurrences?: number;
}

interface CapacityRow {
  group_id: string;
  minimum_instances: number;
  maximum_instances: number;
  minimum_warm_instances: number;
  active_count: number;
  warm_ready: number;
  warm_pending: number;
  requested_cpu: number;
  requested_memory_bytes: number;
  needed_instance_count: number;
  online_host_count: number;
  maximum_free_cpu: number;
  maximum_free_memory_bytes: number;
  aggregate_free_cpu: number;
  aggregate_free_memory_bytes: number;
  feasible_host_count: number;
}

interface FailureRow {
  group_id: string;
  variant_id: string;
  variant_revision: number;
  state: "BACKING_OFF" | "PROBING" | "BLOCKED" | "RESETTING";
  occurrence_count: number;
  last_failed_instance_id: string | null;
  last_failure_reason: string | null;
  last_observed_at: DatabaseTimestamp;
}

interface HostRow {
  id: string;
  health_state: "RECOVERING" | "ONLINE" | "OFFLINE";
  admin_state: "ACTIVE" | "DRAINING" | "MAINTENANCE";
  last_error: string | null;
  assigned_count: number;
}

interface AggregateFailureRow {
  group_id: string;
  operation?: string;
  occurrence_count: number;
  affected_ids: string[];
  last_observed_at: DatabaseTimestamp;
}

interface MaintenanceRow {
  host_id: string;
  blocked_instances: string[];
}

export interface IncidentListQuery {
  readonly status?: "active" | "resolved" | "all";
  readonly severity?: IncidentSeverity;
  readonly kind?: IncidentKind;
  readonly groupId?: string;
  readonly scopeId?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

const detectorKinds: readonly IncidentKind[] = [
  "CAPACITY_BLOCKED",
  "INSTANCE_FAILURE_LOOP",
  "HOST_UNAVAILABLE",
  "HOST_RECOVERY_STUCK",
  "HOST_MAINTENANCE_BLOCKED",
  "TRANSFER_FAILURE_LOOP",
  "COMMAND_FAILURE_LOOP",
];

function asDate(value: DatabaseTimestamp): Date {
  return value instanceof Date ? value : new Date(value);
}

function iso(value: DatabaseTimestamp): string {
  return asDate(value).toISOString();
}

export class IncidentController {
  private running = false;
  private readonly healthyLoops = new Set<string>();

  public constructor(
    private readonly db: Database,
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

  public async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const observations = await this.detect();
      await this.reconcile(observations);
    } catch (error) {
      this.logger.error("incident.reconciliation.failed", "Incident reconciliation failed", { error });
      throw error;
    } finally {
      this.running = false;
    }
  }

  public async recordLoopFailure(task: string, error: unknown): Promise<void> {
    this.healthyLoops.delete(task);
    await this.observe({
      fingerprint: `control-loop:${task}`,
      kind: "CONTROL_LOOP_FAILURE",
      severity: "CRITICAL",
      scopeType: "CLUSTER",
      scopeId: task,
      summary: `Control loop ${task} is repeatedly failing`,
      cause: "SCHEDULED_TASK_FAILED",
      evidence: { task, error: error instanceof Error ? error.message : String(error) },
      openAfterOccurrences: this.config.incidentFailureThreshold,
    }, true);
  }

  public async recordLoopSuccess(task: string): Promise<void> {
    if (this.healthyLoops.has(task)) return;
    await this.resolve(`control-loop:${task}`);
    this.healthyLoops.add(task);
  }

  public async prune(): Promise<void> {
    await this.db.delete(operationalIncidents).where(and(
      eq(operationalIncidents.state, "RESOLVED"),
      lt(
        operationalIncidents.resolvedAt,
        new Date(Date.now() - this.config.incidentHistoryRetentionMs),
      ),
    ));
  }

  public async list(query: IncidentListQuery): Promise<DashboardIncidentPage> {
    const limit = Math.max(1, Math.min(200, Math.trunc(query.limit ?? 50)));
    const filters = [];
    if ((query.status ?? "active") === "active") filters.push(eq(operationalIncidents.state, "ACTIVE"));
    if (query.status === "resolved") filters.push(eq(operationalIncidents.state, "RESOLVED"));
    if (query.status === "all") filters.push(ne(operationalIncidents.state, "PENDING"));
    if (query.severity) filters.push(eq(operationalIncidents.severity, query.severity));
    if (query.kind) filters.push(eq(operationalIncidents.kind, query.kind));
    if (query.groupId) filters.push(eq(operationalIncidents.groupId, query.groupId));
    if (query.scopeId) filters.push(eq(operationalIncidents.scopeId, query.scopeId));
    const cursor = query.cursor ? this.decodeCursor(query.cursor) : null;
    if (cursor) {
      filters.push(or(
        lt(operationalIncidents.lastObservedAt, cursor.at),
        and(
          eq(operationalIncidents.lastObservedAt, cursor.at),
          lt(operationalIncidents.id, cursor.id),
        ),
      )!);
    }
    const [rows, counts] = await Promise.all([
      this.db.select().from(operationalIncidents)
        .where(and(...filters))
        .orderBy(desc(operationalIncidents.lastObservedAt), desc(operationalIncidents.id))
        .limit(limit + 1),
      this.db.select({
        active: sql<number>`count(*) FILTER (WHERE ${operationalIncidents.state} = 'ACTIVE')::int`.mapWith(Number),
        critical: sql<number>`count(*) FILTER (
          WHERE ${operationalIncidents.state} = 'ACTIVE'
            AND ${operationalIncidents.severity} = 'CRITICAL'
        )::int`.mapWith(Number),
      }).from(operationalIncidents),
    ]);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      activeCount: counts[0]?.active ?? 0,
      criticalCount: counts[0]?.critical ?? 0,
      incidents: page.map((row) => ({
        id: row.id,
        kind: row.kind,
        severity: row.severity,
        status: row.state === "RESOLVED" ? "RESOLVED" : "ACTIVE",
        scope: {
          type: row.scopeType,
          id: row.scopeId,
          groupId: row.groupId,
          variantId: row.variantId,
        },
        summary: row.summary,
        cause: row.cause,
        evidence: row.evidence as Readonly<Record<string, unknown>>,
        occurrenceCount: row.occurrenceCount,
        firstObservedAt: row.firstObservedAt.toISOString(),
        lastObservedAt: row.lastObservedAt.toISOString(),
        openedAt: row.openedAt!.toISOString(),
        resolvedAt: row.resolvedAt?.toISOString() ?? null,
      })),
      nextCursor: rows.length > limit && last
        ? Buffer.from(JSON.stringify({ at: last.lastObservedAt.toISOString(), id: last.id })).toString("base64url")
        : null,
    };
  }

  private decodeCursor(value: string): { at: Date; id: string } {
    try {
      const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as {
        at?: unknown;
        id?: unknown;
      };
      const at = new Date(String(decoded.at));
      if (!Number.isFinite(at.getTime()) || typeof decoded.id !== "string") throw new Error();
      return { at, id: decoded.id };
    } catch {
      throw new Error("Invalid incident cursor");
    }
  }

  private async detect(): Promise<Observation[]> {
    const [capacity, failures, hosts, maintenance, transfers, commands] = await Promise.all([
      this.detectCapacity(),
      this.detectInstanceFailures(),
      this.detectHosts(),
      this.detectMaintenance(),
      this.detectTransferFailures(),
      this.detectCommandFailures(),
    ]);
    return [...capacity, ...failures, ...hosts, ...maintenance, ...transfers, ...commands];
  }

  private async detectCapacity(): Promise<Observation[]> {
    const rows = await this.db.execute(sql<CapacityRow>`
      WITH reservations AS (
        SELECT host_id, sum(reserved_cpu) AS cpu, sum(reserved_memory_bytes) AS memory
        FROM server_instances
        WHERE lifecycle_state <> 'STOPPED' AND host_id IS NOT NULL
        GROUP BY host_id
      ), host_capacity AS (
        SELECT hosts.id,
          hosts.allocatable_cpu - coalesce(reservations.cpu, 0) AS free_cpu,
          hosts.allocatable_memory_bytes - coalesce(reservations.memory, 0) AS free_memory
        FROM execution_hosts hosts
        LEFT JOIN reservations ON reservations.host_id = hosts.id
        WHERE hosts.health_state = 'ONLINE' AND hosts.admin_state = 'ACTIVE'
      ), group_state AS (
        SELECT groups.id AS group_id, groups.minimum_instances, groups.maximum_instances,
          groups.minimum_warm_instances,
          count(instances.id) FILTER (WHERE instances.lifecycle_state IN ('CREATING','STARTING','RUNNING','DRAINING'))::int AS active_count,
          count(instances.id) FILTER (WHERE instances.lifecycle_state = 'RUNNING' AND instances.availability_state = 'OPEN')::int AS warm_ready,
          count(instances.id) FILTER (WHERE instances.lifecycle_state IN ('CREATING','STARTING') AND instances.availability_state = 'OPEN')::int AS warm_pending,
          min((variants.runtime_spec->>'cpu')::float8) AS requested_cpu,
          min((variants.runtime_spec->>'memoryBytes')::bigint) AS requested_memory_bytes
        FROM server_groups groups
        JOIN server_group_variants membership ON membership.group_id = groups.id AND membership.enabled = true
        JOIN server_variants variants ON variants.id = membership.variant_id
        LEFT JOIN server_instances instances ON instances.group_id = groups.id
        WHERE groups.enabled = true
        GROUP BY groups.id
      )
      SELECT state.*,
        greatest(
          state.minimum_instances - state.active_count,
          state.minimum_warm_instances - state.warm_ready - state.warm_pending,
          0
        )::int AS needed_instance_count,
        (SELECT count(*)::int FROM host_capacity) AS online_host_count,
        coalesce((SELECT max(free_cpu) FROM host_capacity), 0)::float8 AS maximum_free_cpu,
        coalesce((SELECT max(free_memory) FROM host_capacity), 0)::bigint AS maximum_free_memory_bytes,
        coalesce((SELECT sum(free_cpu) FROM host_capacity), 0)::float8 AS aggregate_free_cpu,
        coalesce((SELECT sum(free_memory) FROM host_capacity), 0)::bigint AS aggregate_free_memory_bytes,
        (SELECT count(*)::int FROM host_capacity
          WHERE free_cpu >= state.requested_cpu AND free_memory >= state.requested_memory_bytes
        ) AS feasible_host_count
      FROM group_state state
      WHERE state.active_count < state.minimum_instances
        OR state.warm_ready + state.warm_pending < state.minimum_warm_instances
    `) as unknown as CapacityRow[];
    return rows.flatMap((row): Observation[] => {
      const requiredCpu = row.requested_cpu * row.needed_instance_count;
      const requiredMemoryBytes = Number(row.requested_memory_bytes) * row.needed_instance_count;
      const cpuBlocked = row.maximum_free_cpu < row.requested_cpu
        || row.aggregate_free_cpu < requiredCpu;
      const memoryBlocked = row.maximum_free_memory_bytes < row.requested_memory_bytes
        || Number(row.aggregate_free_memory_bytes) < requiredMemoryBytes;
      const cause = row.active_count >= row.maximum_instances
        ? "GROUP_MAXIMUM_REACHED"
        : row.online_host_count === 0
          ? "NO_ONLINE_HOST"
          : cpuBlocked && memoryBlocked
            ? "INSUFFICIENT_RESOURCES"
            : cpuBlocked
              ? "INSUFFICIENT_CPU"
              : memoryBlocked
                ? "INSUFFICIENT_MEMORY"
                : row.feasible_host_count > 0
                  ? "PLACEMENT_CONFLICT"
                  : "INSUFFICIENT_RESOURCES";
      // A deficit with a feasible placement is normal convergence: the capacity
      // controller can create the next instance, so it must not age into an incident.
      if (cause === "PLACEMENT_CONFLICT") return [];
      return [{
        fingerprint: `capacity:${row.group_id}`,
        kind: "CAPACITY_BLOCKED",
        severity: "CRITICAL",
        scopeType: "GROUP",
        scopeId: row.group_id,
        groupId: row.group_id,
        summary: `Group ${row.group_id} cannot reach its configured minimum capacity`,
        cause,
        evidence: {
          active: row.active_count,
          minimumInstances: row.minimum_instances,
          warmReady: row.warm_ready,
          warmPending: row.warm_pending,
          minimumWarmInstances: row.minimum_warm_instances,
          requestedCpu: row.requested_cpu,
          requestedMemoryBytes: Number(row.requested_memory_bytes),
          neededInstanceCount: row.needed_instance_count,
          requiredCpu,
          requiredMemoryBytes,
          onlineHostCount: row.online_host_count,
          maximumFreeCpu: row.maximum_free_cpu,
          maximumFreeMemoryBytes: Number(row.maximum_free_memory_bytes),
          aggregateFreeCpu: row.aggregate_free_cpu,
          aggregateFreeMemoryBytes: Number(row.aggregate_free_memory_bytes),
        },
        openAfterMs: this.config.incidentBlockedAfterMs,
      } satisfies Observation];
    });
  }

  private async detectInstanceFailures(): Promise<Observation[]> {
    const rows = await this.db.execute(sql<FailureRow>`
      SELECT group_id, variant_id, variant_revision, state,
        failure_count AS occurrence_count,
        last_failed_instance_id,
        last_failure_reason,
        last_failure_at AS last_observed_at
      FROM variant_start_states
      WHERE state IN ('BACKING_OFF', 'PROBING', 'BLOCKED', 'RESETTING')
    `) as unknown as FailureRow[];
    return rows.map((row) => ({
      fingerprint: `instance-failure:${row.group_id}:${row.variant_id}:${row.variant_revision}`,
      kind: "INSTANCE_FAILURE_LOOP",
      severity: row.state === "BLOCKED" ? "CRITICAL" : "WARNING",
      scopeType: "VARIANT",
      scopeId: row.variant_id,
      groupId: row.group_id,
      variantId: row.variant_id,
      summary: `Variant ${row.variant_id} revision ${row.variant_revision} is failing to start`,
      cause: row.last_failure_reason ?? "STARTUP_FAILURE",
      evidence: {
        revision: row.variant_revision,
        state: row.state,
        lastFailedInstanceId: row.last_failed_instance_id,
      },
      occurrenceCount: Number(row.occurrence_count),
    }));
  }

  private async detectHosts(): Promise<Observation[]> {
    const rows = await this.db.execute(sql<HostRow>`
      SELECT hosts.id, hosts.health_state, hosts.admin_state, hosts.last_error,
        count(instances.id) FILTER (WHERE instances.lifecycle_state <> 'STOPPED')::int AS assigned_count
      FROM execution_hosts hosts
      LEFT JOIN server_instances instances ON instances.host_id = hosts.id
      WHERE hosts.admin_state <> 'MAINTENANCE' AND hosts.health_state <> 'ONLINE'
      GROUP BY hosts.id
    `) as unknown as HostRow[];
    return rows.map((row) => ({
      fingerprint: `host-health:${row.id}`,
      kind: row.health_state === "OFFLINE" ? "HOST_UNAVAILABLE" : "HOST_RECOVERY_STUCK",
      severity: row.health_state === "OFFLINE" && row.assigned_count > 0 ? "CRITICAL" : "WARNING",
      scopeType: "HOST",
      scopeId: row.id,
      summary: row.health_state === "OFFLINE"
        ? `Execution host ${row.id} is offline`
        : `Execution host ${row.id} is not completing recovery`,
      cause: row.health_state === "OFFLINE" ? "HOST_OFFLINE" : "HOST_RECOVERING",
      evidence: { assignedInstanceCount: row.assigned_count, lastError: row.last_error },
      openAfterMs: row.health_state === "OFFLINE" ? 0 : this.config.incidentHostRecoveryAfterMs,
    }));
  }

  private async detectMaintenance(): Promise<Observation[]> {
    const rows = await this.db.execute(sql<MaintenanceRow>`
      SELECT hosts.id AS host_id, array_agg(instances.id ORDER BY instances.created_at) AS blocked_instances
      FROM execution_hosts hosts
      JOIN server_instances instances ON instances.host_id = hosts.id
      WHERE hosts.admin_state = 'DRAINING'
        AND instances.lifecycle_state = 'RUNNING'
        AND instances.availability_state = 'OPEN'
        AND NOT EXISTS (
          SELECT 1 FROM server_instances replacement
          WHERE replacement.replaces_instance_id = instances.id
            AND replacement.lifecycle_state IN ('CREATING','STARTING','RUNNING')
        )
      GROUP BY hosts.id
    `) as unknown as MaintenanceRow[];
    return rows.map((row) => ({
      fingerprint: `host-maintenance:${row.host_id}`,
      kind: "HOST_MAINTENANCE_BLOCKED",
      severity: "WARNING",
      scopeType: "HOST",
      scopeId: row.host_id,
      summary: `Host ${row.host_id} cannot move its open instances`,
      cause: "REPLACEMENT_NOT_CREATED",
      evidence: { instanceIds: row.blocked_instances },
      openAfterMs: this.config.incidentBlockedAfterMs,
    }));
  }

  private async detectTransferFailures(): Promise<Observation[]> {
    const rows = await this.db.execute(sql<AggregateFailureRow>`
      SELECT instances.group_id, count(*)::int AS occurrence_count,
        array_agg(commands.id ORDER BY commands.completed_at DESC) AS affected_ids,
        max(commands.completed_at) AS last_observed_at
      FROM transfer_commands commands
      JOIN server_instances instances ON instances.id = commands.instance_id
      WHERE commands.state = 'EXPIRED'
        AND commands.completed_at >= now() - (${this.config.incidentFailureWindowMs} * interval '1 millisecond')
      GROUP BY instances.group_id HAVING count(*) >= ${this.config.incidentFailureThreshold}
    `) as unknown as AggregateFailureRow[];
    return rows.map((row) => ({
      fingerprint: `transfer-failure:${row.group_id}`,
      kind: "TRANSFER_FAILURE_LOOP",
      severity: "WARNING",
      scopeType: "GROUP",
      scopeId: row.group_id,
      groupId: row.group_id,
      summary: `Player transfers to group ${row.group_id} are repeatedly expiring`,
      cause: "TRANSFER_COMMAND_EXPIRED",
      evidence: { commandIds: row.affected_ids, windowMs: this.config.incidentFailureWindowMs },
      occurrenceCount: Number(row.occurrence_count),
    }));
  }

  private async detectCommandFailures(): Promise<Observation[]> {
    const rows = await this.db.execute(sql<AggregateFailureRow>`
      SELECT instances.group_id, commands.operation, count(*)::int AS occurrence_count,
        array_agg(commands.id ORDER BY commands.completed_at DESC) AS affected_ids,
        max(commands.completed_at) AS last_observed_at
      FROM commands
      JOIN server_instances instances ON instances.id = commands.instance_id
      WHERE commands.state = 'FAILED'
        AND commands.completed_at >= now() - (${this.config.incidentFailureWindowMs} * interval '1 millisecond')
      GROUP BY instances.group_id, commands.operation
      HAVING count(*) >= ${this.config.incidentFailureThreshold}
    `) as unknown as AggregateFailureRow[];
    return rows.map((row) => ({
      fingerprint: `command-failure:${row.group_id}:${row.operation}`,
      kind: "COMMAND_FAILURE_LOOP",
      severity: "WARNING",
      scopeType: "GROUP",
      scopeId: row.group_id,
      groupId: row.group_id,
      summary: `${row.operation} commands for group ${row.group_id} are repeatedly failing`,
      cause: `${row.operation}_COMMAND_FAILED`,
      evidence: { commandIds: row.affected_ids, operation: row.operation, windowMs: this.config.incidentFailureWindowMs },
      occurrenceCount: Number(row.occurrence_count),
    }));
  }

  private async reconcile(observations: readonly Observation[]): Promise<void> {
    const observed = new Set(observations.map((item) => item.fingerprint));
    for (const observation of observations) await this.observe(observation, false);
    const unresolved = await this.db.select({
      fingerprint: operationalIncidents.fingerprint,
    }).from(operationalIncidents).where(and(
      inArray(operationalIncidents.kind, detectorKinds),
      ne(operationalIncidents.state, "RESOLVED"),
    ));
    for (const incident of unresolved) {
      if (!observed.has(incident.fingerprint)) await this.resolve(incident.fingerprint);
    }
  }

  private async observe(observation: Observation, increment: boolean): Promise<void> {
    const transition = await this.db.transaction(async (tx) => {
      const current = await tx.select().from(operationalIncidents).where(and(
        eq(operationalIncidents.fingerprint, observation.fingerprint),
        ne(operationalIncidents.state, "RESOLVED"),
      )).for("update").limit(1);
      const now = new Date();
      const existing = current[0];
      if (!existing) {
        const occurrences = observation.occurrenceCount ?? 1;
        const active = (observation.openAfterMs ?? 0) === 0
          && occurrences >= (observation.openAfterOccurrences ?? 1);
        const inserted = await tx.insert(operationalIncidents).values({
          id: nanoid(),
          fingerprint: observation.fingerprint,
          kind: observation.kind,
          severity: observation.severity,
          state: active ? "ACTIVE" : "PENDING",
          scopeType: observation.scopeType,
          scopeId: observation.scopeId,
          groupId: observation.groupId ?? null,
          variantId: observation.variantId ?? null,
          summary: observation.summary,
          cause: observation.cause,
          evidence: observation.evidence,
          occurrenceCount: occurrences,
          firstObservedAt: now,
          lastObservedAt: now,
          openedAt: active ? now : null,
        }).returning();
        return active ? { type: "opened" as const, incident: inserted[0]! } : null;
      }
      const occurrences = observation.occurrenceCount
        ?? (increment ? existing.occurrenceCount + 1 : existing.occurrenceCount);
      const age = now.getTime() - existing.firstObservedAt.getTime();
      const hasTimeThreshold = observation.openAfterMs !== undefined;
      const hasOccurrenceThreshold = observation.openAfterOccurrences !== undefined;
      const active = existing.state === "ACTIVE"
        || (!hasTimeThreshold && !hasOccurrenceThreshold)
        || (hasTimeThreshold && age >= observation.openAfterMs!)
        || (hasOccurrenceThreshold && occurrences >= observation.openAfterOccurrences!);
      const changed = await tx.update(operationalIncidents).set({
        kind: observation.kind,
        severity: observation.severity,
        state: active ? "ACTIVE" : "PENDING",
        summary: observation.summary,
        cause: observation.cause,
        evidence: observation.evidence,
        occurrenceCount: occurrences,
        lastObservedAt: now,
        openedAt: active ? existing.openedAt ?? now : null,
        updatedAt: now,
      }).where(eq(operationalIncidents.id, existing.id)).returning();
      return existing.state === "PENDING" && active
        ? { type: "opened" as const, incident: changed[0]! }
        : null;
    });
    if (transition?.type === "opened") this.logTransition("opened", transition.incident);
  }

  private async resolve(fingerprint: string): Promise<void> {
    const transition = await this.db.transaction(async (tx) => {
      const rows = await tx.select().from(operationalIncidents).where(and(
        eq(operationalIncidents.fingerprint, fingerprint),
        ne(operationalIncidents.state, "RESOLVED"),
      )).for("update").limit(1);
      const incident = rows[0];
      if (!incident) return null;
      if (incident.state === "PENDING") {
        await tx.delete(operationalIncidents).where(eq(operationalIncidents.id, incident.id));
        return null;
      }
      const now = new Date();
      const resolved = await tx.update(operationalIncidents).set({
        state: "RESOLVED",
        resolvedAt: now,
        updatedAt: now,
      }).where(eq(operationalIncidents.id, incident.id)).returning();
      return resolved[0] ?? null;
    });
    if (transition) this.logTransition("resolved", transition);
  }

  private logTransition(action: "opened" | "resolved", incident: typeof operationalIncidents.$inferSelect): void {
    const fields = {
      incidentId: incident.id,
      fingerprint: incident.fingerprint,
      kind: incident.kind,
      severity: incident.severity,
      scopeType: incident.scopeType,
      scopeId: incident.scopeId,
      cause: incident.cause,
      evidence: incident.evidence,
    };
    if (action === "opened") {
      this.logger.warn("incident.opened", "Operational incident opened", fields);
    } else {
      this.logger.info("incident.resolved", "Operational incident resolved", fields);
    }
  }
}
