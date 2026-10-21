import { afterEach, describe, expect, test } from "bun:test";
import { readClock, resetClock, syncClock } from "../src/lib/clock";

afterEach(() => resetClock());

const at = (iso: string) => Date.parse(iso);

describe("syncClock", () => {
  test("anchors on the payload's server instant", () => {
    syncClock("2026-07-27T12:00:00.000Z");
    expect(readClock()).toBe(at("2026-07-27T12:00:00.000Z"));
  });

  test("follows the server rather than the browser clock", () => {
    // A device running five minutes fast must not inflate every age by five
    // minutes: the anchor is the orchestrator's instant, not Date.now().
    syncClock("2026-07-27T12:00:00.000Z");
    expect(Math.abs(readClock() - Date.now())).toBeGreaterThan(0);
    expect(readClock()).toBe(at("2026-07-27T12:00:00.000Z"));
  });

  test("moves forward when a fresher payload lands", () => {
    syncClock("2026-07-27T12:00:00.000Z");
    syncClock("2026-07-27T12:00:05.000Z");
    expect(readClock()).toBe(at("2026-07-27T12:00:05.000Z"));
  });

  test("ignores an out-of-order response so the clock never rewinds", () => {
    syncClock("2026-07-27T12:00:05.000Z");
    syncClock("2026-07-27T12:00:00.000Z");
    expect(readClock()).toBe(at("2026-07-27T12:00:05.000Z"));
  });

  test("ignores absent and unparseable timestamps", () => {
    syncClock("2026-07-27T12:00:00.000Z");
    syncClock(null);
    syncClock(undefined);
    syncClock("not-a-date");
    expect(readClock()).toBe(at("2026-07-27T12:00:00.000Z"));
  });

  test("reads zero until the first payload has been seen", () => {
    expect(readClock()).toBe(0);
  });
});
