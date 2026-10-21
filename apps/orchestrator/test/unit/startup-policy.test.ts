import { describe, expect, test } from "bun:test";
import {
  countsAsStartupFailure,
  decideStartupFailure,
} from "../../src/domain/startup-policy.ts";

describe("variant startup policy", () => {
  test("uses five exponential retries and blocks the sixth failure", () => {
    expect([1, 2, 3, 4, 5].map((failureCount) =>
      decideStartupFailure(failureCount, 5, 1_000)
    )).toEqual([
      { state: "BACKING_OFF", delayMs: 1_000 },
      { state: "BACKING_OFF", delayMs: 2_000 },
      { state: "BACKING_OFF", delayMs: 4_000 },
      { state: "BACKING_OFF", delayMs: 8_000 },
      { state: "BACKING_OFF", delayMs: 16_000 },
    ]);
    expect(decideStartupFailure(6, 5, 1_000)).toEqual({
      state: "BLOCKED",
      delayMs: null,
    });
  });

  test("counts only failures before readiness", () => {
    expect(countsAsStartupFailure("CREATE_FAILED", false)).toBeTrue();
    expect(countsAsStartupFailure("STARTUP_TIMEOUT", false)).toBeTrue();
    expect(countsAsStartupFailure("RUNTIME_MISSING", false)).toBeTrue();
    expect(countsAsStartupFailure("RUNTIME_MISSING", true)).toBeFalse();
    expect(countsAsStartupFailure("HOST_OFFLINE", false)).toBeFalse();
    expect(countsAsStartupFailure("HOST_MAINTENANCE", false)).toBeFalse();
  });
});
