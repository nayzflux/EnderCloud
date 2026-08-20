import { describe, expect, test } from "bun:test";
import { selectExecutionHost } from "../../src/domain/host-placement.ts";

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
