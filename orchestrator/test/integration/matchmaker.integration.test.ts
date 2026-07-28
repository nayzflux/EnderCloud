import { describe, expect, test, beforeAll, beforeEach, afterAll, mock } from "bun:test";
import { createDatabase, type SqlClient } from "../../src/db/client.ts";
import { migrateDatabase } from "../../src/db/migrate.ts";
import { Matchmaker } from "../../src/services/matchmaker.ts";
import { QueueService } from "../../src/services/queue-service.ts";
import { serverGroups, serverVariants, serverInstances, queueEntries, queueEntryPlayers, gameSessions, sessionPlayers, instancePlayers, transferCommands } from "../../src/db/schema.ts";
import type { TransferService } from "../../src/services/transfer-service.ts";
import { InstanceController } from "../../src/services/instance-controller.ts";
import type { Executor } from "../../src/executor/executor.ts";
import type { VariantSelector } from "../../src/services/variant-selector.ts";
import type { RedisEventBus } from "../../src/events/redis-bus.ts";
import type { AppConfig } from "../../src/config.ts";
import type { Logger } from "../../src/logger.ts";
import { eq, inArray } from "drizzle-orm";
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

let container: StartedPostgreSqlContainer | undefined;
let sql: ReturnType<typeof createDatabase>["sql"];
let db: ReturnType<typeof createDatabase>["db"];
let matchmaker: Matchmaker;

async function cleanDb() {
  await sql`TRUNCATE TABLE server_groups CASCADE`;
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
    const uri = process.env.TEST_DATABASE_URL ?? await (async () => {
      container = await new PostgreSqlContainer("postgres:15-alpine").start();
      return container.getConnectionUri();
    })();
    
    await migrateDatabase(uri);
    
    const client = createDatabase(uri);
    sql = client.sql;
    db = client.db;
    
    matchmaker = new Matchmaker(db, mockTransfers, mockLogger);
  }, 30000); // Allow time for container to download and start

  beforeEach(async () => {
    await cleanDb();
    (mockTransfers.enqueue as any).mockClear();
  });

  afterAll(async () => {
    if (sql) await sql.end();
    if (container) await container.stop();
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
    const secondPlayerId = crypto.randomUUID();
    
    // Simulate player attached to the waiting session
    await db.insert(sessionPlayers).values([
      {
        sessionId,
        playerId,
        partyId,
        state: "SELECTED",
      },
      {
        sessionId,
        playerId: secondPlayerId,
        partyId,
        state: "SELECTED",
      },
    ]);

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

  test("2.4 creates a FORMING session from the first ticket", async () => {
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
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.state).toBe("FORMING");
    
    const entries = await db.select().from(queueEntries);
    expect(entries[0]!.state).toBe("SELECTED");
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

  test("3.3 backfills after the normal deadline until GAME_STARTING", async () => {
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
    expect(sPlayers).toHaveLength(3);
    
    const allSessions = await db.select().from(gameSessions);
    expect(allSessions).toHaveLength(1);
  });

  test("one ticket can belong to only one session with concurrent workers", async () => {
    const { groupId } = await seedGroup();
    const entryId = nanoid();
    await db.insert(queueEntries).values({
      id: entryId,
      groupId,
      partyId: "concurrent-party",
      state: "QUEUED",
    });
    await db.insert(queueEntryPlayers).values([
      { queueEntryId: entryId, playerId: crypto.randomUUID() },
      { queueEntryId: entryId, playerId: crypto.randomUUID() },
    ]);

    const secondWorker = new Matchmaker(db, mockTransfers, mockLogger);
    await Promise.all([matchmaker.tick(), secondWorker.tick()]);

    const entries = await db.select().from(queueEntries).where(eq(queueEntries.id, entryId));
    const sessions = await db.select().from(gameSessions);
    expect(entries[0]!.sessionId).toBeTruthy();
    expect(sessions).toHaveLength(1);
    expect(entries[0]!.sessionId).toBe(sessions[0]!.id);
  });

  test("GAME_STARTING locks only an eligible connected profile and cancels pending transfers", async () => {
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
      state: "WAITING",
      waitingDeadline: new Date(Date.now() + 60_000),
    });
    await db.update(serverInstances)
      .set({ sessionId, availabilityState: "RESERVED" })
      .where(eq(serverInstances.id, instanceId));
    await db.insert(sessionPlayers).values([
      {
        sessionId,
        playerId: crypto.randomUUID(),
        partyId: "lock-a",
        state: "CONNECTED",
      },
      {
        sessionId,
        playerId: crypto.randomUUID(),
        partyId: "lock-b",
        state: "CONNECTED",
      },
    ]);
    await db.insert(transferCommands).values({
      id: nanoid(),
      instanceId,
      sessionId,
      payload: { instanceId, endpoint: "localhost:25565", players: [] },
      expiresAt: new Date(Date.now() + 60_000),
    });
    const controller = new InstanceController(
      db,
      {} as Executor,
      {} as VariantSelector,
      {} as RedisEventBus,
      {} as TransferService,
      {} as AppConfig,
      mockLogger,
    );

    await expect(
      controller.handlePaperEvent(instanceId, { type: "GAME_STARTING", sessionId }),
    ).rejects.toThrow("not lock eligible");
    await db.update(gameSessions)
      .set({ waitingDeadline: new Date(Date.now() - 1_000) })
      .where(eq(gameSessions.id, sessionId));
    await controller.handlePaperEvent(instanceId, { type: "GAME_STARTING", sessionId });

    const sessions = await db.select().from(gameSessions).where(eq(gameSessions.id, sessionId));
    const commands = await db.select().from(transferCommands);
    expect(sessions[0]!.state).toBe("STARTING");
    expect(commands[0]!.state).toBe("CANCELLED");
  });

  test("GAME_CANCELLED rapidly drains connected minigame players to an available hub", async () => {
    const { groupId, variantId } = await seedGroup();
    const hubGroupId = "test-hub";
    const hubVariantId = "test-hub-variant";
    await db.insert(serverGroups).values({
      id: hubGroupId,
      type: "hub",
      enabled: true,
      minimumInstances: 1,
      maximumInstances: 3,
      minimumWarmInstances: 1,
      maximumWarmInstances: 2,
      maximumPlayersPerInstance: 100,
      targetPlayersPerInstance: 70,
      startupTimeoutMs: 60_000,
      drainingTimeoutMs: 60_000,
      shutdownTimeoutMs: 20_000,
    });
    await db.insert(serverVariants).values({
      id: hubVariantId,
      groupId: hubGroupId,
      templatePath: "none",
      enabled: true,
      revision: 1,
      selectionWeight: 100,
      checksum: "none",
      runtimeSpec: {},
    });
    const sourceInstanceId = nanoid();
    const hubInstanceId = nanoid();
    const sessionId = nanoid();
    const playerIds = [crypto.randomUUID(), crypto.randomUUID()];
    await db.insert(serverInstances).values([
      {
        id: sourceInstanceId,
        groupId,
        variantId,
        lifecycleState: "RUNNING",
        availabilityState: "OPEN",
        endpoint: "minigame:25565",
        playerCount: playerIds.length,
      },
      {
        id: hubInstanceId,
        groupId: hubGroupId,
        variantId: hubVariantId,
        lifecycleState: "RUNNING",
        availabilityState: "OPEN",
        endpoint: "hub:25565",
      },
    ]);
    await db.insert(gameSessions).values({
      id: sessionId,
      groupId,
      instanceId: sourceInstanceId,
      state: "RUNNING",
    });
    await db.update(serverInstances)
      .set({ sessionId, availabilityState: "RESERVED" })
      .where(eq(serverInstances.id, sourceInstanceId));
    await db.insert(sessionPlayers).values(playerIds.map((playerId) => ({
      sessionId,
      playerId,
      partyId: `party-${playerId}`,
      state: "CONNECTED" as const,
    })));
    await db.insert(instancePlayers).values(playerIds.map((playerId) => ({
      instanceId: sourceInstanceId,
      playerId,
    })));

    const evacuationTransfers = {
      enqueue: async (tx: any, payload: any) => {
        const id = nanoid();
        await tx.insert(transferCommands).values({
          id,
          instanceId: payload.instanceId,
          payload,
          expiresAt: new Date(Date.now() + 20_000),
        });
        return id;
      },
    } as unknown as TransferService;
    const bus = {
      publishRegistry: mock(async () => {}),
    } as unknown as RedisEventBus;
    const controller = new InstanceController(
      db,
      {} as Executor,
      {} as VariantSelector,
      bus,
      evacuationTransfers,
      { cancelledDrainTimeoutMs: 10_000 } as AppConfig,
      mockLogger,
    );

    await controller.handlePaperEvent(sourceInstanceId, {
      type: "GAME_CANCELLED",
      sessionId,
      reason: "not enough teams",
    });
    await controller.handlePaperEvent(sourceInstanceId, {
      type: "GAME_CANCELLED",
      sessionId,
      reason: "duplicate notification",
    });

    const [session] = await db.select().from(gameSessions)
      .where(eq(gameSessions.id, sessionId));
    const [source] = await db.select().from(serverInstances)
      .where(eq(serverInstances.id, sourceInstanceId));
    const commands = await db.select().from(transferCommands);
    expect(session!.state).toBe("CANCELLED");
    expect(source!.lifecycleState).toBe("DRAINING");
    expect(source!.drainDeadline!.getTime()).toBeLessThanOrEqual(Date.now() + 10_000);
    expect(commands).toHaveLength(1);
    expect(commands[0]!.instanceId).toBe(hubInstanceId);
    const evacuation = commands[0]!.payload as {
      instanceId: string;
      endpoint: string;
      players: string[];
      sourceInstanceId: string;
      reason: string;
    };
    expect(evacuation.instanceId).toBe(hubInstanceId);
    expect(evacuation.endpoint).toBe("hub:25565");
    expect(evacuation.players.toSorted()).toEqual(playerIds.toSorted());
    expect(evacuation.sourceInstanceId).toBe(sourceInstanceId);
    expect(evacuation.reason).toBe("SESSION_CANCELLED");
  });

  test("a departure cancels the whole ticket before transfer and only one player afterwards", async () => {
    const { groupId, variantId } = await seedGroup();
    const queues = new QueueService(db);
    const beforePlayers = [crypto.randomUUID(), crypto.randomUUID()];
    await queues.enqueue({ groupId, partyId: "before-transfer", players: beforePlayers });
    await matchmaker.tick();
    await queues.networkDisconnected(beforePlayers[0]!);
    const beforeRows = await db.select().from(sessionPlayers);
    expect(beforeRows.every((player) => player.state === "LEFT")).toBeTrue();

    const instanceId = nanoid();
    await db.insert(serverInstances).values({
      id: instanceId,
      groupId,
      variantId,
      lifecycleState: "RUNNING",
      availabilityState: "OPEN",
      endpoint: "localhost:25565",
    });
    const afterPlayers = [crypto.randomUUID(), crypto.randomUUID()];
    await queues.enqueue({ groupId, partyId: "after-transfer", players: afterPlayers });
    await matchmaker.tick();
    await queues.networkDisconnected(afterPlayers[0]!);
    const afterRows = await db.select().from(sessionPlayers)
      .where(inArray(sessionPlayers.playerId, afterPlayers));
    expect(afterRows.find((player) => player.playerId === afterPlayers[0])?.state).toBe("LEFT");
    expect(afterRows.find((player) => player.playerId === afterPlayers[1])?.state).toBe("TRANSFERRING");

    const previousSessionId = afterRows[0]!.sessionId;
    const requeued = await queues.enqueue({
      groupId,
      partyId: "after-transfer",
      players: [afterPlayers[0]!],
    });
    expect(requeued.state).toBe("QUEUED");
    await matchmaker.tick();

    const playerHistory = await db.select().from(sessionPlayers)
      .where(eq(sessionPlayers.playerId, afterPlayers[0]!));
    expect(playerHistory).toHaveLength(1);
    expect(playerHistory[0]!.sessionId).toBe(previousSessionId);
    expect(playerHistory[0]!.state).toBe("TRANSFERRING");
    expect(playerHistory[0]!.queueEntryId).toBe(requeued.entryId);
  });
});
