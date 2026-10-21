import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GET } from "../src/app/api/incidents/route";

describe("dashboard incident route", () => {
  const original = process.env.DASHBOARD_MOCK_DATA;

  beforeAll(() => {
    process.env.DASHBOARD_MOCK_DATA = "true";
  });

  afterAll(() => {
    if (original === undefined) delete process.env.DASHBOARD_MOCK_DATA;
    else process.env.DASHBOARD_MOCK_DATA = original;
  });

  test("filters mock incidents by severity, kind, group and host scope", async () => {
    const critical = await GET(new Request(
      "http://dashboard/api/incidents?status=active&severity=CRITICAL&kind=CAPACITY_BLOCKED&groupId=skywars-solo",
    ));
    expect(critical.status).toBe(200);
    const criticalBody = await critical.json() as { incidents: { cause: string }[] };
    expect(criticalBody.incidents).toEqual([expect.objectContaining({ cause: "INSUFFICIENT_CPU" })]);

    const host = await GET(new Request(
      "http://dashboard/api/incidents?scopeId=host-lyon-02",
    ));
    const hostBody = await host.json() as { incidents: { kind: string }[] };
    expect(hostBody.incidents.map((incident) => incident.kind)).toEqual(["HOST_RECOVERY_STUCK"]);
  });

  test("rejects unsupported filters and limits above 200", async () => {
    expect((await GET(new Request("http://dashboard/api/incidents?status=pending"))).status).toBe(400);
    expect((await GET(new Request("http://dashboard/api/incidents?limit=201"))).status).toBe(400);
    expect((await GET(new Request("http://dashboard/api/incidents?unknown=true"))).status).toBe(400);
  });
});
