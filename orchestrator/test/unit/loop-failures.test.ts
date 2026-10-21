import { expect, test } from "bun:test";
import { SessionController } from "../../src/services/session-controller.ts";
import type { Database } from "../../src/db/client.ts";
import type { InstanceController } from "../../src/services/instance-controller.ts";
import type { TransferService } from "../../src/services/transfer-service.ts";
import type { HubRouter } from "../../src/services/hub-router.ts";
import { Logger } from "../../src/logger.ts";

test("session stages continue independently but report partial failure to the scheduler", async () => {
  const controller = new SessionController({} as Database, {} as InstanceController, {} as TransferService, {} as HubRouter, new Logger("error", { sink: () => {} }));
  let calls = 0;
  for (const method of ["expireTransfers", "expirePlayerPresence", "advanceWaitingSessions", "recoverFailedInstances", "releaseTerminalReservations", "finishDrainingInstances"]) {
    Reflect.set(controller, method, async () => { calls += 1; if (method === "recoverFailedInstances") throw Error("SQL unavailable"); });
  }
  await expect(controller.tick()).rejects.toBeInstanceOf(AggregateError);
  expect(calls).toBe(6);
  await expect(controller.tick()).rejects.toBeInstanceOf(AggregateError);
  expect(calls).toBe(12);
});
