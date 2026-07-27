import { describe, expect, test } from "bun:test";
import {
  formatAge,
  formatBytes,
  formatCountdown,
  formatDuration,
  formatRelativeTime,
  humanizeState,
  ratio,
  shortId,
} from "../src/lib/format";

const now = Date.parse("2026-07-27T12:00:00.000Z");

describe("formatRelativeTime", () => {
  test("collapses the last few seconds", () => {
    expect(formatRelativeTime("2026-07-27T11:59:58.000Z", now)).toBe("just now");
  });

  test("reports past and future", () => {
    expect(formatRelativeTime("2026-07-27T11:58:00.000Z", now)).toBe("2m 00s ago");
    expect(formatRelativeTime("2026-07-27T12:02:00.000Z", now)).toBe("in 2m 00s");
  });

  test("falls back to an em dash for missing or invalid values", () => {
    expect(formatRelativeTime(null, now)).toBe("—");
    expect(formatRelativeTime("not-a-date", now)).toBe("—");
  });
});

describe("formatAge", () => {
  test("scales from seconds to days", () => {
    expect(formatAge("2026-07-27T11:59:15.000Z", now)).toBe("45s");
    expect(formatAge("2026-07-27T11:30:00.000Z", now)).toBe("30m 00s");
    expect(formatAge("2026-07-27T09:00:00.000Z", now)).toBe("3h 00m");
    expect(formatAge("2026-07-25T09:00:00.000Z", now)).toBe("2d 03h");
  });

  test("never goes negative", () => {
    expect(formatAge("2026-07-27T12:05:00.000Z", now)).toBe("0s");
  });
});

describe("formatCountdown", () => {
  test("counts down and then flags the overrun", () => {
    expect(formatCountdown("2026-07-27T12:00:30.000Z", now)).toBe("30s");
    expect(formatCountdown("2026-07-27T11:59:30.000Z", now)).toBe(
      "overdue by 30s",
    );
  });
});

describe("formatDuration", () => {
  test("keeps sub-second values in milliseconds", () => {
    expect(formatDuration(450)).toBe("450ms");
  });

  test("switches to the compact duration above a second", () => {
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(900_000)).toBe("15m 00s");
  });
});

describe("formatBytes", () => {
  test("prefers gibibytes and drops trailing zeros", () => {
    expect(formatBytes(4 * 1024 ** 3)).toBe("4 GiB");
    expect(formatBytes(1.5 * 1024 ** 3)).toBe("1.5 GiB");
  });

  test("falls back to mebibytes below a gibibyte", () => {
    expect(formatBytes(512 * 1024 ** 2)).toBe("512 MiB");
  });
});

describe("ratio", () => {
  test("clamps to 0–100 and tolerates a zero total", () => {
    expect(ratio(5, 10)).toBe(50);
    expect(ratio(20, 10)).toBe(100);
    expect(ratio(-1, 10)).toBe(0);
    expect(ratio(3, 0)).toBe(0);
  });
});

describe("humanizeState", () => {
  test("turns contract enums into sentence case", () => {
    expect(humanizeState("WAITING_FOR_INSTANCE")).toBe("Waiting for instance");
    expect(humanizeState("RUNNING")).toBe("Running");
  });
});

describe("shortId", () => {
  test("only truncates when it has to", () => {
    expect(shortId("abcdefgh")).toBe("abcdefgh");
    expect(shortId("abcdefghijklmnop")).toBe("abcdefgh…");
  });
});
