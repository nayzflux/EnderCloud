import { expect, test } from "bun:test";
import { instanceName } from "../src/executor/local-docker.ts";

test("Docker instance names include the variant and unique instance id", () => {
  expect(
    instanceName(
      "skywars-solo-japan",
      "6c3e143b-9357-4db2-9c81-a64f69ec8d0d",
    ),
  ).toBe(
    "endercloud-skywars-solo-japan-6c3e143b-9357-4db2-9c81-a64f69ec8d0d",
  );
});
