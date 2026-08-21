import { describe, expect, test } from "bun:test";
import { selectExecutionHost } from "../../src/domain/host-placement.ts";
import { classifyPlacementBlock } from "../../src/services/host-service.ts";

const gibibyte = 1024 ** 3;

describe("execution host placement", () => {
  test("filters hosts that cannot fit both requested resources", () => {
    const selected = selectExecutionHost(
      [
        {
          id: "cpu-full",
          allocatableCpu: 4,
          allocatableMemoryBytes: 8 * gibibyte,
          reservedCpu: 3.5,
          reservedMemoryBytes: 0,
        },
        {
          id: "memory-full",
          allocatableCpu: 4,
          allocatableMemoryBytes: 8 * gibibyte,
          reservedCpu: 0,
          reservedMemoryBytes: 7.5 * gibibyte,
        },
        {
          id: "fits",
          allocatableCpu: 4,
          allocatableMemoryBytes: 8 * gibibyte,
          reservedCpu: 2,
          reservedMemoryBytes: 4 * gibibyte,
        },
      ],
      { cpu: 1, memoryBytes: gibibyte },
    );

    expect(selected?.id).toBe("fits");
  });

  test("uses the lowest dominant utilization", () => {
    const selected = selectExecutionHost(
      [
        {
          id: "memory-heavy",
          allocatableCpu: 8,
          allocatableMemoryBytes: 16 * gibibyte,
          reservedCpu: 1,
          reservedMemoryBytes: 12 * gibibyte,
        },
        {
          id: "balanced",
          allocatableCpu: 8,
          allocatableMemoryBytes: 16 * gibibyte,
          reservedCpu: 4,
          reservedMemoryBytes: 4 * gibibyte,
        },
      ],
      { cpu: 1, memoryBytes: gibibyte },
    );

    expect(selected?.id).toBe("balanced");
  });

  test("breaks equal utilization ties by stable host id", () => {
    const selected = selectExecutionHost(
      ["host-b", "host-a"].map((id) => ({
        id,
        allocatableCpu: 8,
        allocatableMemoryBytes: 16 * gibibyte,
        reservedCpu: 2,
        reservedMemoryBytes: 4 * gibibyte,
      })),
      { cpu: 1, memoryBytes: gibibyte },
    );

    expect(selected?.id).toBe("host-a");
  });

  test("returns null without a feasible host", () => {
    expect(
      selectExecutionHost(
        [
          {
            id: "small",
            allocatableCpu: 1,
            allocatableMemoryBytes: gibibyte,
            reservedCpu: 0,
            reservedMemoryBytes: 0,
          },
        ],
        { cpu: 2, memoryBytes: 2 * gibibyte },
      ),
    ).toBeNull();
  });
});

describe("structured placement diagnostics", () => {
  const requested = { cpu: 2, memoryBytes: 4 * gibibyte };

  test("distinguishes missing hosts and each exhausted resource", () => {
    expect(classifyPlacementBlock([], requested)).toBe("NO_ONLINE_HOST");
    expect(classifyPlacementBlock([
      { freeCpu: 1, freeMemoryBytes: 8 * gibibyte },
    ], requested)).toBe("INSUFFICIENT_CPU");
    expect(classifyPlacementBlock([
      { freeCpu: 4, freeMemoryBytes: 2 * gibibyte },
    ], requested)).toBe("INSUFFICIENT_MEMORY");
    expect(classifyPlacementBlock([
      { freeCpu: 1, freeMemoryBytes: 2 * gibibyte },
    ], requested)).toBe("INSUFFICIENT_RESOURCES");
  });

  test("reports a placement conflict when advertised capacity should fit", () => {
    expect(classifyPlacementBlock([
      { freeCpu: 4, freeMemoryBytes: 8 * gibibyte },
    ], requested)).toBe("PLACEMENT_CONFLICT");
  });
});
