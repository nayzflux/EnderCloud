import { describe, expect, test } from "bun:test";
import { nanoid } from "../../src/id.ts";

describe("nanoid", () => {
  test("generates 16 alphanumeric characters", () => {
    const ids = Array.from({ length: 100 }, () => nanoid());

    expect(ids.every((id) => /^[A-Za-z0-9]{16}$/.test(id))).toBe(true);
  });
});
