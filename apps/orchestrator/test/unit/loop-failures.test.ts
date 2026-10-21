import { expect, test } from "bun:test";
import { SessionController } from "../../src/modules/sessions/controller.ts";
import type { Database } from "../../src/db/client.ts";
import type { InstanceController } from "../../src/modules/instances/lifecycle.ts";
import type { TransferService } from "../../src/modules/transfers/service.ts";
import type { HubRouter } from "../../src/modules/routing/hubs.ts";
import { Logger } from "@endercloud/runtime/logger";

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
