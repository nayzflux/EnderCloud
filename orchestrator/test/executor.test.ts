import { expect, test } from "bun:test";
import { instanceName } from "../src/executor/local-docker.ts";

test("Docker instance names include the variant and unique instance id", () => {
  expect(
    instanceName(
      "skywars-solo-japan",
      "aB3dE5fG7hJ9kL2m",
    ),
  ).toBe(
    "endercloud-skywars-solo-japan-aB3dE5fG7hJ9kL2m",
  );
});
