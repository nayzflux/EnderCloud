import type { ChartConfig } from "@/components/ui/chart";
import type { DashboardMonitoringSeries } from "./contracts";

export type StartupMetric = "totalAverageMs" | "bootAverageMs";
export type TpsMetric = "oneMinute" | "fiveMinutes" | "fifteenMinutes";

export interface MonitoringChartRow {
  readonly at: string;
  readonly [key: string]: string | number;
}

const monitoringLineColor = "var(--color-blue-500)";

export function sampleKey(variantId: string): string {
  return `${variantId}__samples`;
}

export function buildVariantChartConfig(
  variants: DashboardMonitoringSeries["variants"],
): ChartConfig {
  return Object.fromEntries(
    variants.map((variant) => [
      variant.variantId,
      {
        label: variant.variantId,
        color: monitoringLineColor,
      },
    ]),
  );
}

function mergePoints(
  variants: DashboardMonitoringSeries["variants"],
  read: (
    variant: DashboardMonitoringSeries["variants"][number],
  ) => readonly { readonly at: string; readonly value: number; readonly sampleCount: number }[],
): MonitoringChartRow[] {
  const rows = new Map<string, Record<string, string | number>>();
  for (const variant of variants) {
    for (const point of read(variant)) {
      const row = rows.get(point.at) ?? { at: point.at };
      row[variant.variantId] = point.value;
      row[sampleKey(variant.variantId)] = point.sampleCount;
      rows.set(point.at, row);
    }
  }
  return [...rows.values()].sort((left, right) =>
    String(left.at).localeCompare(String(right.at)),
  ) as MonitoringChartRow[];
}

export function buildStartupChartRows(
  variants: DashboardMonitoringSeries["variants"],
  metric: StartupMetric,
): MonitoringChartRow[] {
  return mergePoints(variants, (variant) =>
    variant.startup.map((point) => ({
      at: point.at,
      value: point[metric],
      sampleCount: point.sampleCount,
    })),
  );
}

export function buildTpsChartRows(
  variants: DashboardMonitoringSeries["variants"],
  metric: TpsMetric,
): MonitoringChartRow[] {
  return mergePoints(variants, (variant) =>
    variant.tps.map((point) => ({
      at: point.at,
      value: point[metric],
      sampleCount: point.sampleCount,
    })),
  );
}
