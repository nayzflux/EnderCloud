import { expect, test } from "bun:test";
import { InstanceStartWorker } from "../../src/modules/instances/start-worker.ts";
import type { InstanceController } from "../../src/modules/instances/lifecycle.ts";
import type { Database } from "../../src/db/client.ts";
import type { Executor } from "@endercloud/contracts/executor";
import { Logger } from "@endercloud/runtime/logger";

test("startup task rejection is contained and queued for recovery", async () => {
  const worker = new InstanceStartWorker({} as Database, {
    executeCreate: async () => { throw new Error("temporary database failure"); },
  } as unknown as InstanceController, {} as Executor, new Logger("error", { sink: () => {} }), 1);
  const internals = worker as unknown as {
    launch(command: { commandId: string; instanceId: string; attempt: number }): void;
    active: Map<string, Promise<void>>;
    recoveries: Map<string, string>;
    accepting: boolean;
  };
  internals.accepting = false;
  internals.launch({ commandId: "command", instanceId: "instance", attempt: 1 });
  await Promise.all(internals.active.values());
  expect(internals.active.size).toBe(0);
  expect(internals.recoveries.get("command")).toBe("temporary database failure");
});

test("shutdown waits for an in-flight claim and requeues it without launching work", async () => {
  let release!: (value: { commandId: string; instanceId: string; attempt: number }[]) => void;
  const gate = new Promise<{ commandId: string; instanceId: string; attempt: number }[]>(resolve => { release = resolve; });
  let requeued = 0; let launched = 0;
  const db = { update: () => ({ set: () => ({ where: async () => { requeued++; } }) }) } as unknown as Database;
  const worker = new InstanceStartWorker(db, {} as InstanceController, {} as Executor, new Logger("error", { sink: () => {} }), 1);
  const internals = worker as unknown as { claim: () => typeof gate; launch: () => void };
  internals.claim = () => gate;
  internals.launch = () => { launched++; };
  worker.recoverInterrupted = async () => 0;
  const tick = worker.tick(); const stop = worker.stop();
  release([{ commandId: "command", instanceId: "instance", attempt: 1 }]);
  await Promise.all([tick, stop]);
  expect(launched).toBe(0); expect(requeued).toBe(1);
});
