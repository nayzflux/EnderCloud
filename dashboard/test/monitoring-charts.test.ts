import { describe, expect, test } from "bun:test";
import type { DashboardMonitoringSeries } from "../src/lib/contracts";
import {
  buildStartupChartRows,
  buildTpsChartRows,
  buildVariantChartConfig,
  sampleKey,
} from "../src/lib/monitoring-charts";

const variants: DashboardMonitoringSeries["variants"] = [
  {
    variantId: "skywars-japan",
    enabled: true,
    startup: [{
      at: "2026-08-01T12:00:00.000Z",
      totalAverageMs: 42_000,
      bootAverageMs: 31_000,
      sampleCount: 3,
    }],
    tps: [{
      at: "2026-08-01T12:00:00.000Z",
      oneMinute: 19.5,
      fiveMinutes: 19.7,
      fifteenMinutes: 19.9,
      sampleCount: 6,
    }],
  },
  {
    variantId: "skywars-legacy",
    enabled: true,
    startup: [{
      at: "2026-08-01T12:00:00.000Z",
      totalAverageMs: 66_000,
      bootAverageMs: 57_000,
      sampleCount: 2,
    }],
    tps: [],
  },
];

describe("monitoring chart models", () => {
  test("builds semantic shadcn chart configuration per variant", () => {
    expect(buildVariantChartConfig(variants)).toEqual({
      "skywars-japan": {
        label: "skywars-japan",
        color: "var(--color-blue-500)",
      },
      "skywars-legacy": {
        label: "skywars-legacy",
        color: "var(--color-blue-500)",
      },
    });
  });

  test("merges startup variants and keeps tooltip sample counts", () => {
    expect(buildStartupChartRows(variants, "bootAverageMs")).toEqual([{
      at: "2026-08-01T12:00:00.000Z",
      "skywars-japan": 31_000,
      [sampleKey("skywars-japan")]: 3,
      "skywars-legacy": 57_000,
      [sampleKey("skywars-legacy")]: 2,
    }]);
  });

  test("selects the requested native Paper TPS window", () => {
    expect(buildTpsChartRows(variants, "fiveMinutes")).toEqual([{
      at: "2026-08-01T12:00:00.000Z",
      "skywars-japan": 19.7,
      [sampleKey("skywars-japan")]: 6,
    }]);
  });
});
