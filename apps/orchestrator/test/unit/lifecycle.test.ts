import { expect, test } from "bun:test";
import { ResourceScope } from "@endercloud/runtime/lifecycle";

test("startup cleanup is reverse ordered, idempotent and continues after errors", async () => {
  const scope = new ResourceScope();
  const events: string[] = [];
  scope.defer("database", () => {
    events.push("database");
  });
  scope.defer("bus", () => {
    events.push("bus");
    throw new Error("unavailable");
  });
  scope.defer("http", () => {
    events.push("http");
  });
  const cleanup = scope.close();
  expect(scope.close()).toBe(cleanup);
  await expect(cleanup).rejects.toThrow("Resource cleanup failed");
  expect(events).toEqual(["http", "bus", "database"]);
});
test("a stuck resource cannot prevent independent cleanup", async () => {
  const scope = new ResourceScope();
  let closed = false;
  scope.defer("database", () => {
    closed = true;
  });
  scope.defer("stuck", () => new Promise(() => {}));
  await expect(scope.close(5)).rejects.toThrow();
  expect(closed).toBe(true);
});
