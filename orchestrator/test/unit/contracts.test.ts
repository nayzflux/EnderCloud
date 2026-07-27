import { expect, test } from "bun:test";

test("shared contract fixtures match the TypeScript protocol", async () => {
  const transfer = await Bun.file(
    new URL("../../../contracts/fixtures/transfer-players.json", import.meta.url),
  ).json();
  const assignment = await Bun.file(
    new URL("../../../contracts/fixtures/assignment.json", import.meta.url),
  ).json();
  expect(transfer.schemaVersion).toBe(1);
  expect(transfer.type).toBe("TRANSFER_PLAYERS");
  expect(assignment.state).toBe("WAITING");
  expect(assignment.players[0].teamIndex).toBe(0);
});
