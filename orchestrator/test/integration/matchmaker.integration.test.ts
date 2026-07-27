import { describe, expect, test, beforeAll, beforeEach, afterAll, mock } from "bun:test";
import { createDatabase, type SqlClient } from "../../src/db/client.ts";
import { migrateDatabase } from "../../src/db/migrate.ts";
import { Matchmaker } from "../../src/services/matchmaker.ts";
import { serverGroups, serverVariants, serverInstances, queueEntries, queueEntryPlayers, gameSessions, sessionPlayers } from "../../src/db/schema.ts";
import type { TransferService } from "../../src/services/transfer-service.ts";
import type { Logger } from "../../src/logger.ts";
import { eq } from "drizzle-orm";
import { nanoid } from "../../src/id.ts";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";

const mockLogger = {
  minimum: "debug",
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: console.error,
  write: () => {},
} as unknown as Logger;

const mockTransfers = {
  enqueue: mock(async () => {
    return "mocked-cmd-id";
  }),
} as unknown as TransferService;

let container: StartedPostgreSqlContainer;
let sql: ReturnType<typeof createDatabase>["sql"];
let db: ReturnType<typeof createDatabase>["db"];
let matchmaker: Matchmaker;

async function cleanDb() {
  await sql`TRUNCATE TABLE server_groups CASCADE;`;
}

async function seedGroup() {
  const groupId = "test-group";
  await db.insert(serverGroups).values({
    id: groupId,
    type: "minigame",
    enabled: true,
    minimumPlayers: 2,
    maximumPlayers: 4,
    teamCount: 2,
    teamSize: 2,
    waitingTimeoutMs: 5000,
    minimumInstances: 0,
    maximumInstances: 10,
    minimumWarmInstances: 0,
    maximumWarmInstances: 2,
    startupTimeoutMs: 60000,
    drainingTimeoutMs: 60000,
    shutdownTimeoutMs: 60000,
  });
  
  const variantId = "test-variant";
  await db.insert(serverVariants).values({
    id: variantId,
    groupId,
    templatePath: "none",
    enabled: true,
    revision: 1,
    selectionWeight: 100,
    checksum: "none",
    runtimeSpec: {},
  });
  
  return { groupId, variantId };
}

describe("Matchmaker Integration (Section 2 & 3)", () => {
  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:15-alpine").start();
    const uri = container.getConnectionUri();
    
    await migrateDatabase(uri);
    
    const client = createDatabase(uri);
    sql = client.sql;
    db = client.db;
    
    matchmaker = new Matchmaker(sql, mockTransfers, mockLogger);
  }, 30000); // Allow time for container to download and start

  beforeEach(async () => {
    await cleanDb();
    (mockTransfers.enqueue as any).mockClear();
  });

  afterAll(async () => {
    await sql.end();
    await container.stop();
  });

  test("2.1 Happy Path: Formation with warm instance", async () => {
    const { groupId, variantId } = await seedGroup();

    // 1. Add a warm instance (RUNNING, OPEN)
    const instanceId = nanoid();
    await db.insert(serverInstances).values({
      id: instanceId,
      groupId,
      variantId,
      lifecycleState: "RUNNING",
      availabilityState: "OPEN",
      endpoint: "localhost:25565",
    });

    // 2. Add 2 players to the queue
    const entryId = nanoid();
    await db.insert(queueEntries).values({
      id: entryId,
      groupId,
      partyId: nanoid(),
      state: "QUEUED",
    });
    await db.insert(queueEntryPlayers).values([
      { queueEntryId: entryId, playerId: crypto.randomUUID() },
      { queueEntryId: entryId, playerId: crypto.randomUUID() },
    ]);

    // Action : Tick!
    await matchmaker.tick();

    // Assertions
    const sessions = await db.select().from(gameSessions);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.state).toBe("TRANSFERRING");
    expect(sessions[0]!.instanceId).toBe(instanceId);

    const instances = await db.select().from(serverInstances).where(eq(serverInstances.id, instanceId));
    expect(instances[0]!.availabilityState).toBe("RESERVED");
    expect(instances[0]!.sessionId).toBe(sessions[0]!.id);

    const entries = await db.select().from(queueEntries);
    expect(entries[0]!.state).toBe("SELECTED");
    
    expect(mockTransfers.enqueue).toHaveBeenCalledTimes(1);
  });

  test("2.2 Cold Start: Formation without instance (Waiting For Instance)", async () => {
    const { groupId } = await seedGroup();

    const entryId = nanoid();
    await db.insert(queueEntries).values({
      id: entryId,
      groupId,
      partyId: nanoid(),
      state: "QUEUED",
    });
    await db.insert(queueEntryPlayers).values([
      { queueEntryId: entryId, playerId: crypto.randomUUID() },
      { queueEntryId: entryId, playerId: crypto.randomUUID() },
    ]);

    await matchmaker.tick();

    const sessions = await db.select().from(gameSessions);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.state).toBe("WAITING_FOR_INSTANCE");
    expect(sessions[0]!.instanceId).toBeNull();
    
    expect(mockTransfers.enqueue).toHaveBeenCalledTimes(0);
  });

  test("2.3 Pending Sessions Assignment (assignWaitingSession)", async () => {
    const { groupId, variantId } = await seedGroup();

    // 1. Create a session in WAITING_FOR_INSTANCE with a player
    const sessionId = nanoid();
    await db.insert(gameSessions).values({
      id: sessionId,
      groupId,
      state: "WAITING_FOR_INSTANCE",
      waitingDeadline: new Date(Date.now() + 10000), // In the future
    });

    const partyId = nanoid();
    const playerId = crypto.randomUUID();
    
    // Simulate player attached to the waiting session
    await db.insert(sessionPlayers).values({
      sessionId,
      playerId,
      partyId,
      teamIndex: 0,
      state: "SELECTED",
    });

    // 2. Add an available warm instance
    const instanceId = nanoid();
    await db.insert(serverInstances).values({
      id: instanceId,
      groupId,
      variantId,
      lifecycleState: "RUNNING",
      availabilityState: "OPEN",
      endpoint: "localhost:25565",
    });

    // Action : Tick!
    await matchmaker.tick();

    // Assertions
    const sessions = await db.select().from(gameSessions).where(eq(gameSessions.id, sessionId));
    expect(sessions[0]!.state).toBe("TRANSFERRING");
    expect(sessions[0]!.instanceId).toBe(instanceId);

    const instances = await db.select().from(serverInstances).where(eq(serverInstances.id, instanceId));
    expect(instances[0]!.availabilityState).toBe("RESERVED");
    expect(instances[0]!.sessionId).toBe(sessionId);

    const sPlayers = await db.select().from(sessionPlayers).where(eq(sessionPlayers.sessionId, sessionId));
    expect(sPlayers[0]!.state).toBe("TRANSFERRING");
    
    expect(mockTransfers.enqueue).toHaveBeenCalledTimes(1);
  });

  test("2.4 Minimum players constraint: Does not form a session if players are missing", async () => {
    const { groupId, variantId } = await seedGroup();

    await db.insert(serverInstances).values({
      id: nanoid(),
      groupId,
      variantId,
      lifecycleState: "RUNNING",
      availabilityState: "OPEN",
      endpoint: "localhost:25565",
    });

    const entryId = nanoid();
    await db.insert(queueEntries).values({
      id: entryId,
      groupId,
      partyId: nanoid(),
      state: "QUEUED",
    });
    await db.insert(queueEntryPlayers).values([
      { queueEntryId: entryId, playerId: crypto.randomUUID() },
    ]); // 1 player, minimum=2

    await matchmaker.tick();

    const sessions = await db.select().from(gameSessions);
    expect(sessions).toHaveLength(0);
    
    const entries = await db.select().from(queueEntries);
    expect(entries[0]!.state).toBe("QUEUED");
  });

  test("3.1 & 3.2 Successful Backfill and Team Stability", async () => {
    const { groupId, variantId } = await seedGroup();

    const instanceId = nanoid();
    const sessionId = nanoid();

    await db.insert(serverInstances).values({
      id: instanceId,
      groupId,
      variantId,
      lifecycleState: "RUNNING",
      availabilityState: "OPEN",
      endpoint: "localhost:25565",
    });

    await db.insert(gameSessions).values({
      id: sessionId,
      groupId,
      instanceId,
      state: "TRANSFERRING",
      waitingDeadline: new Date(Date.now() + 10000), // Waiting for backfill
      assignmentRevision: 1,
    });

    await db.update(serverInstances)
      .set({ availabilityState: "RESERVED", sessionId })
      .where(eq(serverInstances.id, instanceId));

    const partyId1 = nanoid();
    const playerId1 = crypto.randomUUID();
    await db.insert(sessionPlayers).values({
      sessionId,
      playerId: playerId1,
      partyId: partyId1,
      teamIndex: 0,
      state: "SELECTED",
    });

    const entryId = nanoid();
    await db.insert(queueEntries).values({
      id: entryId,
      groupId,
      partyId: nanoid(),
      state: "QUEUED",
    });
    await db.insert(queueEntryPlayers).values([
      { queueEntryId: entryId, playerId: crypto.randomUUID() },
      { queueEntryId: entryId, playerId: crypto.randomUUID() },
    ]);

    await matchmaker.tick();

    const sessions = await db.select().from(gameSessions).where(eq(gameSessions.id, sessionId));
    expect(sessions[0]!.assignmentRevision).toBe(2);

    const sPlayers = await db.select().from(sessionPlayers).where(eq(sessionPlayers.sessionId, sessionId));
    expect(sPlayers).toHaveLength(3);
    
    expect(mockTransfers.enqueue).toHaveBeenCalledTimes(1);
  });

  test("3.3 Backfill Timeout: Ignores the session if deadline is exceeded", async () => {
    const { groupId, variantId } = await seedGroup();

    const instanceId = nanoid();
    const sessionId = nanoid();

    await db.insert(serverInstances).values({
      id: instanceId,
      groupId,
      variantId,
      lifecycleState: "RUNNING",
      availabilityState: "OPEN",
      endpoint: "localhost:25565",
    });

    await db.insert(gameSessions).values({
      id: sessionId,
      groupId,
      instanceId,
      state: "TRANSFERRING",
      waitingDeadline: new Date(Date.now() - 10000), // Past
    });

    await db.update(serverInstances)
      .set({ availabilityState: "RESERVED", sessionId })
      .where(eq(serverInstances.id, instanceId));

    const partyId1 = nanoid();
    const playerId1 = crypto.randomUUID();
    await db.insert(sessionPlayers).values({
      sessionId,
      playerId: playerId1,
      partyId: partyId1,
      teamIndex: 0,
      state: "SELECTED",
    });

    const entryId = nanoid();
    await db.insert(queueEntries).values({
      id: entryId,
      groupId,
      partyId: nanoid(),
      state: "QUEUED",
    });
    await db.insert(queueEntryPlayers).values([
      { queueEntryId: entryId, playerId: crypto.randomUUID() },
      { queueEntryId: entryId, playerId: crypto.randomUUID() },
    ]);

    await matchmaker.tick();

    const sPlayers = await db.select().from(sessionPlayers).where(eq(sessionPlayers.sessionId, sessionId));
    expect(sPlayers).toHaveLength(1); 
    
    const allSessions = await db.select().from(gameSessions);
    expect(allSessions).toHaveLength(2); // The old one + a newly created session for the 2 queueing players
  });
});
