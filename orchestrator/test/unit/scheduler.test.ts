import { expect, mock, test } from "bun:test";
import type { Logger } from "../../src/logger.ts";
import { Scheduler } from "../../src/scheduler.ts";

test("scheduler skips overlapping ticks and waits for active work on stop", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const task = mock(async () => blocked);
  const logger = {
    debug: () => {},
    error: () => {},
    runWithContext: (_context: unknown, operation: () => unknown) => operation(),
  } as unknown as Logger;
  const scheduler = new Scheduler(logger);
  scheduler.every("slow", 5, task);
  await Bun.sleep(18);
  expect(task).toHaveBeenCalledTimes(1);
  const stopping = scheduler.stop(100);
  release();
  await stopping;
  expect(task).toHaveBeenCalledTimes(1);
});
