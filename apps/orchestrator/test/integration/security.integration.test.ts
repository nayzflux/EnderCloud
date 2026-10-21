import { afterAll, beforeAll, expect, test } from "bun:test";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { createDatabase } from "../../src/db/client.ts";
import { acquireLeadership } from "../../src/db/leadership.ts";
import { migrateDatabase } from "../../src/db/migrate.ts";
import {
  serviceCredentials,
  apikey,
  serverGroups,
  templateLayers,
  serverVariants,
  serverInstances,
  registryOutbox,
} from "../../src/db/schema.ts";
import { createAuth, authHttpHandler } from "../../src/security/auth.ts";
import { createAuthorizer } from "../../src/security/authorize.ts";
import { Credentials } from "../../src/security/credentials.ts";
import { startOrchestrator } from "../../src/bootstrap.ts";
import { loadConfig } from "../../src/config.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAdministrator, resetAdministrator } from "../../src/security/cli.ts";

let container: StartedPostgreSqlContainer;
let database: ReturnType<typeof createDatabase>;
const config = {
  secret: "test-only-administrator-secret-32-bytes",
  encryptionKey: Buffer.alloc(32, 1),
  origin: "http://localhost:3000",
};
const password = "test-only-password-long-enough";
beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:18.1-alpine").start();
  await migrateDatabase(container.getConnectionUri());
  database = createDatabase(container.getConnectionUri());
  await createAdministrator(database.db, config, "admin@example.test", password);
}, 60_000);
afterAll(async () => {
  await database?.sql.end();
  await container?.stop();
});

test("release schema can reopen; legacy database remains unchanged", async () => {
  await migrateDatabase(container.getConnectionUri());
  await database.sql`CREATE DATABASE legacy_test`;
  const legacyUrl = new URL(container.getConnectionUri());
  legacyUrl.pathname = "/legacy_test";
  const legacy = createDatabase(legacyUrl.href);
  try {
    await legacy.sql`CREATE TABLE sentinel (value text)`;
    await legacy.sql`INSERT INTO sentinel VALUES ('keep-me')`;
    await expect(migrateDatabase(legacyUrl.href)).rejects.toThrow("Legacy database refused");
    expect(await legacy.sql`SELECT value FROM sentinel`).toMatchObject([{ value: "keep-me" }]);
    expect(
      (await legacy.sql`SELECT tablename FROM pg_tables WHERE schemaname='public'`).map(
        (row) => row.tablename,
      ),
    ).toEqual(["sentinel"]);
  } finally {
    await legacy.sql.end();
  }
});

test("database allows only one active orchestrator and releases ownership on shutdown", async () => {
  const url = container.getConnectionUri();
  const release = await acquireLeadership(url, () => {});
  try {
    await expect(acquireLeadership(url, () => {})).rejects.toThrow(
      "Another EnderCloud orchestrator",
    );
  } finally {
    await release();
  }
  const next = await acquireLeadership(url, () => {});
  await next();
});

test("failed startup releases database leadership and all previously opened resources", async () => {
  const directory = await mkdtemp(join(tmpdir(), "endercloud-bootstrap-"));
  try {
    const appConfig = loadConfig({
      DATABASE_URL: container.getConnectionUri(),
      REDIS_URL: "redis://127.0.0.1:1",
      ORCHESTRATOR_GROUPS_DIRECTORY: join(directory, "groups"),
      ORCHESTRATOR_TEMPLATES_DIRECTORY: join(directory, "templates"),
      ORCHESTRATOR_LOG_LEVEL: "error",
    });
    await expect(startOrchestrator(appConfig, config)).rejects.toThrow();
    const release = await acquireLeadership(container.getConnectionUri(), () => {});
    await release();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

test("local administrator signs in, resets sessions and cannot register a second account", async () => {
  const auth = createAuth(database.db, config);
  const handler = authHttpHandler(auth);
  expect(
    (await handler(new Request(`${config.origin}/api/auth/sign-up/email`, { method: "POST" })))
      .status,
  ).toBe(404);
  await expect(
    createAdministrator(database.db, config, "other@example.test", password),
  ).rejects.toThrow();
  const signedIn = await handler(
    new Request(`${config.origin}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: config.origin },
      body: JSON.stringify({ email: "admin@example.test", password }),
    }),
  );
  expect(signedIn.status).toBe(200);
  const cookie = signedIn.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  expect(cookie).toContain("endercloud.session_token=");
  // Session checks are not login attempts; normal polling must not exhaust the auth limiter.
  for (let index = 0; index < 110; index++) {
    const response = await handler(
      new Request(`${config.origin}/api/auth/get-session`, { headers: { cookie } }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ session: { id: expect.any(String) } });
  }
  const authorize = createAuthorizer(database.db, auth);
  await authorize(
    new Request(`${config.origin}/api/v1/dashboard/cluster`, { headers: { cookie } }),
  );
  await expect(
    authorize(
      new Request(`${config.origin}/api/v1/hosts/worker-one/drain`, {
        method: "POST",
        headers: { cookie, origin: "https://evil.test" },
      }),
    ),
  ).rejects.toMatchObject({ status: 403 });
  await resetAdministrator(database.db, password);
  await expect(
    authorize(new Request(`${config.origin}/api/v1/dashboard/cluster`, { headers: { cookie } })),
  ).rejects.toMatchObject({ status: 401 });
});

test("service keys are encrypted, bound to resources, rotated and revoked without administrator sessions", async () => {
  const auth = createAuth(database.db, config);
  const credentials = new Credentials(database.db, auth, config);
  const authorize = createAuthorizer(database.db, auth);
  const first = await credentials.ensure("agent", "worker-one");
  const [stored] = await database.db
    .select()
    .from(serviceCredentials)
    .where(eq(serviceCredentials.id, "agent:worker-one"));
  expect(stored!.encryptedSecret).not.toContain(first.apiToken);
  expect(stored!.encryptedSecret).not.toContain(first.controlToken!);
  expect(await credentials.get("agent", "worker-one")).toEqual(first);
  const request = (path: string, token = first.apiToken, method = "PUT") =>
    new Request(`${config.origin}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}` },
    });
  await authorize(request("/api/v1/hosts/worker-one/heartbeat"));
  await expect(authorize(request("/api/v1/hosts/worker-two/heartbeat"))).rejects.toMatchObject({
    status: 403,
  });
  await expect(
    authorize(request("/api/v1/dashboard/cluster", first.apiToken, "GET")),
  ).rejects.toMatchObject({ status: 403 });
  expect(
    await auth.api.getSession({
      headers: new Headers({ authorization: `Bearer ${first.apiToken}` }),
    }),
  ).toBeNull();
  const rotated = await credentials.ensure("agent", "worker-one", true);
  expect(rotated.controlToken).not.toBe(first.controlToken);
  await expect(authorize(request("/api/v1/hosts/worker-one/heartbeat"))).rejects.toMatchObject({
    status: 401,
  });
  await authorize(request("/api/v1/hosts/worker-one/heartbeat", rotated.apiToken));
  await database.db
    .update(apikey)
    .set({ expiresAt: new Date(0) })
    .where(eq(apikey.id, (await database.db.select().from(serviceCredentials))[0]!.authKeyId));
  await expect(
    authorize(request("/api/v1/hosts/worker-one/heartbeat", rotated.apiToken)),
  ).rejects.toMatchObject({ status: 401 });
  const newest = await credentials.ensure("agent", "worker-one", true);
  await credentials.revoke("agent", "worker-one");
  await expect(
    authorize(request("/api/v1/hosts/worker-one/heartbeat", newest.apiToken)),
  ).rejects.toMatchObject({ status: 401 });
});

test("public sign-in rate limits repeated failures and exposes no key management API", async () => {
  const handler = authHttpHandler(createAuth(database.db, config));
  expect(
    (await handler(new Request(`${config.origin}/api/auth/api-key/create`, { method: "POST" })))
      .status,
  ).toBe(404);
  const statuses: number[] = [];
  for (let i = 0; i < 7; i++) {
    const response = await handler(
      new Request(`${config.origin}/api/auth/sign-in/email`, {
        method: "POST",
        headers: {
          origin: config.origin,
          "content-type": "application/json",
          "x-forwarded-for": "192.0.2.11",
        },
        body: JSON.stringify({
          email: "admin@example.test",
          password: "wrong-password-but-long-enough",
        }),
      }),
    );
    statuses.push(response.status);
  }
  expect(statuses).toContain(429);
  expect(statuses).not.toContain(200);
});

test("Paper keys cannot control another instance; rotation retires the old identity atomically", async () => {
  const runtime = { image: "alpine:3.22.1", cpu: 1, memoryBytes: 1024, environment: {} };
  await database.db.insert(serverGroups).values({
    id: "security-hubs",
    type: "hub",
    maximumInstances: 1,
    maximumWarmInstances: 1,
    startupTimeoutMs: 30_000,
    drainTimeoutMs: 30_000,
    cancelledDrainTimeoutMs: 1000,
    shutdownTimeoutMs: 1000,
    transferTimeoutMs: 10_000,
    playerStaleTimeoutMs: 30_000,
  });
  await database.db.insert(templateLayers).values({
    id: "security-layer",
    templatePath: "/test",
    checksum: "a".repeat(64),
    runtimePatch: { environment: {} },
    fileSummary: { fileCount: 0, totalBytes: 0, roots: [] },
  });
  await database.db
    .insert(serverVariants)
    .values({ id: "security-layer", checksum: "a".repeat(64), revision: 1, runtimeSpec: runtime });
  const id = "securityinst0001";
  await database.db.insert(serverInstances).values({
    id,
    groupId: "security-hubs",
    variantId: "security-layer",
    lifecycleState: "STARTING",
    availabilityState: "OPEN",
  });
  const auth = createAuth(database.db, config);
  const credentials = new Credentials(database.db, auth, config);
  const token = (await credentials.ensure("paper", id)).apiToken;
  const authorize = createAuthorizer(database.db, auth);
  const request = (resource: string) =>
    new Request(`${config.origin}/api/v1/instances/${resource}/assignment`, {
      headers: { authorization: `Bearer ${token}` },
    });
  await authorize(request(id));
  await expect(authorize(request("securityinst0002"))).rejects.toMatchObject({ status: 403 });
  await credentials.retireInstance(id, "CREDENTIAL_ROTATED");
  await expect(authorize(request(id))).rejects.toMatchObject({ status: 401 });
  expect(
    (await database.db.select().from(serverInstances).where(eq(serverInstances.id, id)))[0],
  ).toMatchObject({ lifecycleState: "FAILED", failureReason: "CREDENTIAL_ROTATED" });
  expect(await database.db.select().from(registryOutbox)).toHaveLength(1);
});
