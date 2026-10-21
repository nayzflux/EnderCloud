import { expect, test } from "bun:test";

test("shared contract fixtures match the TypeScript protocol", async () => {
  const heartbeat: import("@endercloud/contracts/domain").ProxyHeartbeat = await Bun.file(
    new URL("../../../../contracts/fixtures/proxy-heartbeat.json", import.meta.url),
  ).json();
  const control: import("@endercloud/contracts/domain").ProxyControl = await Bun.file(
    new URL("../../../../contracts/fixtures/proxy-control.json", import.meta.url),
  ).json();
  expect(heartbeat).toEqual({ ready: true, playerCount: 12, acceptingConnections: false });
  expect(control).toEqual({
    lifecycleState: "DRAINING",
    acceptingConnections: false,
    controlLeaseMs: 30_000,
  });
  const transfer = await Bun.file(
    new URL("../../../../contracts/fixtures/transfer-players.json", import.meta.url),
  ).json();
  const assignment = await Bun.file(
    new URL("../../../../contracts/fixtures/assignment.json", import.meta.url),
  ).json();
  expect(transfer.schemaVersion).toBe(2);
  expect(transfer.type).toBe("TRANSFER_PLAYERS");
  expect(assignment.state).toBe("WAITING");
  expect(assignment.players[0].teamIndex).toBeUndefined();
  expect(assignment.players[0].ticketId).toBe("queue-ticket-1");
  expect(assignment.acceptingTickets).toBe(true);
  expect(assignment.recommendedProfile).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
});
