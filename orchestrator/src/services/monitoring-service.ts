import { and, asc, eq, lt, sql } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import {
  serverGroups,
  serverGroupVariants,
  serverInstances,
  serverTpsMetrics,
} from "../db/schema.ts";
import type {
  DashboardMonitoringAlert,
  DashboardMonitoringSeries,
  DashboardMonitoringSummary,
  MonitoringRange,
} from "../domain/dashboard.ts";
import type { TpsSnapshot } from "../domain/types.ts";
import type { Logger } from "../logger.ts";

export const TPS_ALERT_THRESHOLD = 19;
export const STARTUP_ALERT_RATIO = 0.6;
export const STARTUP_WINDOW_MS = 60 * 60 * 1_000;
export const TPS_STALE_MS = 2 * 60 * 1_000;
export const TPS_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

const rangeConfiguration = {
  "1h": { durationMs: 60 * 60 * 1_000, resolutionMs: 60 * 1_000 },
  "6h": { durationMs: 6 * 60 * 60 * 1_000, resolutionMs: 5 * 60 * 1_000 },
  "24h": { durationMs: 24 * 60 * 60 * 1_000, resolutionMs: 15 * 60 * 1_000 },
  "7d": { durationMs: 7 * 24 * 60 * 60 * 1_000, resolutionMs: 60 * 60 * 1_000 },
} as const satisfies Record<MonitoringRange, { durationMs: number; resolutionMs: number }>;

export function monitoringRangeConfiguration(range: MonitoringRange) {
  return rangeConfiguration[range];
}

type DatabaseTimestamp = Date | string;

interface StartupPointRow {
  variant_id: string;
  at: DatabaseTimestamp;
  total_average_ms: number;
  boot_average_ms: number;
  sample_count: number;
}

interface TpsPointRow {
  variant_id: string;
  at: DatabaseTimestamp;
  one_minute: number;
  five_minutes: number;
  fifteen_minutes: number;
  sample_count: number;
}

interface TpsAlertRow {
  group_id: string;
  variant_id: string;
  value: number;
  observed_at: DatabaseTimestamp;
}

interface StartupAlertRow {
  group_id: string;
  variant_id: string;
  value_ms: number;
  threshold_ms: number;
  sample_count: number;
  observed_at: DatabaseTimestamp;
}

function iso(value: DatabaseTimestamp): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function rounded(value: number): number {
  return Math.round(Number(value) * 100) / 100;
}

export class MonitoringService {
  private pruning = false;

  public constructor(
    private readonly db: Database,
    private readonly logger: Logger,
  ) {}

  /** Store one compact contribution without making metric failures reject a heartbeat. */
  public async recordTps(instanceId: string, tps: TpsSnapshot | undefined): Promise<void> {
    if (!tps) return;
    try {
      await this.db.execute(sql`
        INSERT INTO server_tps_metrics (
          group_id,
          variant_id,
          bucket_at,
          one_minute_sum,
          five_minutes_sum,
          fifteen_minutes_sum,
          sample_count
        )
        SELECT
          ${serverInstances.groupId},
          ${serverInstances.variantId},
          date_trunc('minute', now()),
          ${tps.oneMinute},
          ${tps.fiveMinutes},
          ${tps.fifteenMinutes},
          1
        FROM ${serverInstances}
        WHERE ${serverInstances.id} = ${instanceId}
        ON CONFLICT (group_id, variant_id, bucket_at) DO UPDATE SET
          one_minute_sum = server_tps_metrics.one_minute_sum + EXCLUDED.one_minute_sum,
          five_minutes_sum = server_tps_metrics.five_minutes_sum + EXCLUDED.five_minutes_sum,
          fifteen_minutes_sum = server_tps_metrics.fifteen_minutes_sum + EXCLUDED.fifteen_minutes_sum,
          sample_count = server_tps_metrics.sample_count + 1
      `);
    } catch (error) {
      this.logger.warn("Unable to record TPS metrics", {
        instanceId,
        error: String(error),
      });
    }
  }

  public async prune(): Promise<void> {
    if (this.pruning) return;
    this.pruning = true;
    try {
      await this.db
        .delete(serverTpsMetrics)
        .where(lt(serverTpsMetrics.bucketAt, sql`now() - interval '7 days'`));
    } finally {
      this.pruning = false;
    }
  }

  public async getSummary(): Promise<DashboardMonitoringSummary> {
    const [tpsRows, startupRows] = await Promise.all([
      this.db.execute(sql<TpsAlertRow>`
        WITH latest AS (
          SELECT DISTINCT ON (metrics.group_id, metrics.variant_id)
            metrics.group_id,
            metrics.variant_id,
            metrics.five_minutes_sum / metrics.sample_count AS value,
            metrics.bucket_at AS observed_at
          FROM server_tps_metrics metrics
          JOIN server_groups groups
            ON groups.id = metrics.group_id AND groups.enabled = true
          JOIN server_group_variants variants
            ON variants.group_id = metrics.group_id
            AND variants.variant_id = metrics.variant_id
            AND variants.enabled = true
          WHERE metrics.bucket_at >= now() - interval '2 minutes'
          ORDER BY metrics.group_id, metrics.variant_id, metrics.bucket_at DESC
        )
        SELECT group_id, variant_id, value, observed_at
        FROM latest
        WHERE value < ${TPS_ALERT_THRESHOLD}
      `) as unknown as Promise<TpsAlertRow[]>,
      this.db.execute(sql<StartupAlertRow>`
        SELECT
          instances.group_id,
          instances.variant_id,
          avg(extract(epoch FROM (instances.running_at - instances.starting_at)) * 1000) AS value_ms,
          groups.startup_timeout_ms * ${STARTUP_ALERT_RATIO}::double precision AS threshold_ms,
          count(*)::int AS sample_count,
          max(instances.running_at) AS observed_at
        FROM server_instances instances
        JOIN server_groups groups
          ON groups.id = instances.group_id AND groups.enabled = true
        JOIN server_group_variants variants
          ON variants.group_id = instances.group_id
          AND variants.variant_id = instances.variant_id
          AND variants.enabled = true
        WHERE instances.starting_at IS NOT NULL
          AND instances.running_at >= now() - interval '60 minutes'
        GROUP BY instances.group_id, instances.variant_id, groups.startup_timeout_ms
        HAVING avg(extract(epoch FROM (instances.running_at - instances.starting_at)) * 1000)
          > groups.startup_timeout_ms * ${STARTUP_ALERT_RATIO}::double precision
      `) as unknown as Promise<StartupAlertRow[]>,
    ]);

    const alerts: DashboardMonitoringAlert[] = [
      ...tpsRows.map((row) => ({
        metric: "TPS_5M" as const,
        groupId: row.group_id,
        variantId: row.variant_id,
        value: rounded(row.value),
        threshold: TPS_ALERT_THRESHOLD,
        observedAt: iso(row.observed_at),
      })),
      ...startupRows.map((row) => ({
        metric: "STARTUP_BOOT_60M" as const,
        groupId: row.group_id,
        variantId: row.variant_id,
        valueMs: rounded(row.value_ms),
        thresholdMs: rounded(row.threshold_ms),
        sampleCount: Number(row.sample_count),
        observedAt: iso(row.observed_at),
      })),
    ];

    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      alerts,
    };
  }

  public async getGroupSeries(
    groupId: string,
    range: MonitoringRange,
  ): Promise<DashboardMonitoringSeries | null> {
    const groups = await this.db
      .select({ startupTimeoutMs: serverGroups.startupTimeoutMs })
      .from(serverGroups)
      .where(eq(serverGroups.id, groupId));
    const group = groups[0];
    if (!group) return null;

    const variants = await this.db
      .select({
        variantId: serverGroupVariants.variantId,
        enabled: serverGroupVariants.enabled,
      })
      .from(serverGroupVariants)
      .where(eq(serverGroupVariants.groupId, groupId))
      .orderBy(asc(serverGroupVariants.variantId));

    const generatedAt = new Date();
    const { durationMs, resolutionMs } = monitoringRangeConfiguration(range);
    const rangeStart = new Date(generatedAt.getTime() - durationMs);
    const rangeStartIso = rangeStart.toISOString();
    const generatedAtIso = generatedAt.toISOString();

    const [startupRows, tpsRows] = await Promise.all([
      this.db.execute(sql<StartupPointRow>`
        WITH points AS (
          SELECT generate_series(
            ${rangeStartIso}::timestamptz,
            ${generatedAtIso}::timestamptz,
            ${resolutionMs} * interval '1 millisecond'
          ) AS at
        )
        SELECT
          variants.variant_id,
          points.at,
          avg(extract(epoch FROM (instances.running_at - instances.created_at)) * 1000) AS total_average_ms,
          avg(extract(epoch FROM (instances.running_at - instances.starting_at)) * 1000) AS boot_average_ms,
          count(instances.id)::int AS sample_count
        FROM server_group_variants variants
        CROSS JOIN points
        LEFT JOIN server_instances instances
          ON instances.group_id = variants.group_id
          AND instances.variant_id = variants.variant_id
          AND instances.starting_at IS NOT NULL
          AND instances.running_at > points.at - interval '60 minutes'
          AND instances.running_at <= points.at
        WHERE variants.group_id = ${groupId}
        GROUP BY variants.variant_id, points.at
        HAVING count(instances.id) > 0
        ORDER BY variants.variant_id, points.at
      `) as unknown as Promise<StartupPointRow[]>,
      this.db.execute(sql<TpsPointRow>`
        SELECT
          metrics.variant_id,
          to_timestamp(
            floor(extract(epoch FROM metrics.bucket_at) / ${resolutionMs / 1_000})
            * ${resolutionMs / 1_000}
          ) AS at,
          sum(metrics.one_minute_sum) / sum(metrics.sample_count) AS one_minute,
          sum(metrics.five_minutes_sum) / sum(metrics.sample_count) AS five_minutes,
          sum(metrics.fifteen_minutes_sum) / sum(metrics.sample_count) AS fifteen_minutes,
          sum(metrics.sample_count)::int AS sample_count
        FROM server_tps_metrics metrics
        WHERE metrics.group_id = ${groupId}
          AND metrics.bucket_at >= ${rangeStartIso}::timestamptz
          AND metrics.bucket_at <= ${generatedAtIso}::timestamptz
        GROUP BY metrics.variant_id, at
        ORDER BY metrics.variant_id, at
      `) as unknown as Promise<TpsPointRow[]>,
    ]);

    const startupByVariant = new Map<string, DashboardMonitoringSeries["variants"][number]["startup"] extends readonly (infer T)[] ? T[] : never>();
    const tpsByVariant = new Map<string, DashboardMonitoringSeries["variants"][number]["tps"] extends readonly (infer T)[] ? T[] : never>();
    for (const row of startupRows) {
      const points = startupByVariant.get(row.variant_id) ?? [];
      points.push({
        at: iso(row.at),
        totalAverageMs: rounded(row.total_average_ms),
        bootAverageMs: rounded(row.boot_average_ms),
        sampleCount: Number(row.sample_count),
      });
      startupByVariant.set(row.variant_id, points);
    }
    for (const row of tpsRows) {
      const points = tpsByVariant.get(row.variant_id) ?? [];
      points.push({
        at: iso(row.at),
        oneMinute: rounded(row.one_minute),
        fiveMinutes: rounded(row.five_minutes),
        fifteenMinutes: rounded(row.fifteen_minutes),
        sampleCount: Number(row.sample_count),
      });
      tpsByVariant.set(row.variant_id, points);
    }

    return {
      schemaVersion: 1,
      generatedAt: generatedAt.toISOString(),
      groupId,
      range,
      resolutionMs,
      thresholds: {
        tps: TPS_ALERT_THRESHOLD,
        startupBootMs: group.startupTimeoutMs * STARTUP_ALERT_RATIO,
      },
      variants: variants.map((variant) => ({
        variantId: variant.variantId,
        enabled: variant.enabled,
        startup: startupByVariant.get(variant.variantId) ?? [],
        tps: tpsByVariant.get(variant.variantId) ?? [],
      })),
    };
  }
}
