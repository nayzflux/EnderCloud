import { expect, test } from "bun:test";
import { Reconciler } from "../../src/services/reconciler.ts";
import type { Database } from "../../src/db/client.ts";
import type { Executor, RuntimeInstance } from "@endercloud/contracts/executor";
import type { InstanceController } from "../../src/services/instance-controller.ts";
import type { HostService } from "../../src/services/host-service.ts";
import { Logger } from "@endercloud/runtime/logger";

test("retained files do not suppress retries to stop a failed container", async () => {
  let attempts = 0;
  const reconciler = new Reconciler({} as Database, { stopInstance: async () => {
    attempts += 1;
    if (attempts === 1) throw Error("temporary Docker failure");
  } } as unknown as Executor, {} as InstanceController, {} as HostService, new Logger("error", { sink: () => {} }), 30_000);
  const reconcile = (reconciler as unknown as { reconcileHost(host: string, instances: unknown[], runtime: RuntimeInstance[]): Promise<boolean> }).reconcileHost.bind(reconciler);
  const instance = { id: "instance", lifecycle_state: "FAILED", runtime_retained: true, shutdown_timeout_ms: 20_000 };
  const runtime = [{ instanceId: "instance", running: true }] as RuntimeInstance[];
  expect(await reconcile("host", [instance], runtime)).toBe(false);
  expect(await reconcile("host", [instance], runtime)).toBe(true);
  expect(attempts).toBe(2);
  expect(instance.runtime_retained).toBe(true);
});
