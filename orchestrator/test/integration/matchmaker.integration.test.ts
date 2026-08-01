import { describe, expect, test, beforeAll, beforeEach, afterAll, mock } from "bun:test";
import { createDatabase, type SqlClient } from "../../src/db/client.ts";
import { migrateDatabase } from "../../src/db/migrate.ts";
import { Matchmaker } from "../../src/services/matchmaker.ts";
import { QueueService } from "../../src/services/queue-service.ts";
import { serverGroups, serverVariants, serverInstances, queueEntries, queueEntryPlayers, gameSessions, sessionPlayers, instancePlayers, transferCommands, events } from "../../src/db/schema.ts";
import type { TransferService } from "../../src/services/transfer-service.ts";
import { InstanceController } from "../../src/services/instance-controller.ts";
import type { Executor, RuntimeInstance } from "../../src/executor/executor.ts";
import { VariantSelector } from "../../src/services/variant-selector.ts";
import type { RedisEventBus } from "../../src/events/redis-bus.ts";
import type { Logger } from "../../src/logger.ts";
import { HubRouter } from "../../src/services/hub-router.ts";
import { and, eq, inArray } from "drizzle-orm";
import { nanoid } from "../../src/id.ts";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { CapacityController } from "../../src/services/capacity-controller.ts";
import { Reconciler } from "../../src/services/reconciler.ts";

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
  await sql`TRUNCATE TABLE server_groups, events CASCADE`;
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
    instanceAcquisitionTimeoutMs: 5000,
    lobbyStaleTimeoutMs: 15_000,
    minimumInstances: 0,
    maximumInstances: 10,
    minimumWarmInstances: 0,
    maximumWarmInstances: 2,
    startupTimeoutMs: 60000,
    drainTimeoutMs: 60000,
    cancelledDrainTimeoutMs: 10_000,
    shutdownTimeoutMs: 60000,
    transferTimeoutMs: 20_000,
    playerStaleTimeoutMs: 30_000,
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
      instanceAcquisitionDeadline: new Date(Date.now() + 10000), // In the future
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
      lobbyStaleDeadline: new Date(Date.now() + 10_000),
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

  test("3.3 backfills until GAME_STARTING while the lobby is fresh", async () => {
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
      lobbyStaleDeadline: new Date(Date.now() + 60_000),
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

  test("GAME_STARTING is authoritative and cancels pending transfers", async () => {
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
      lobbyStaleDeadline: new Date(Date.now() + 60_000),
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
      {} as HubRouter,
      mockLogger,
    );

    await controller.handlePaperEvent(instanceId, { type: "GAME_STARTING", sessionId });

    const sessions = await db.select().from(gameSessions).where(eq(gameSessions.id, sessionId));
    const commands = await db.select().from(transferCommands);
    expect(sessions[0]!.state).toBe("STARTING");
    expect(commands[0]!.state).toBe("CANCELLED");
  });

  test("an eliminated spectator can requeue without leaving the running instance", async () => {
    const { groupId, variantId } = await seedGroup();
    const instanceId = nanoid();
    const sessionId = nanoid();
    const eliminatedPlayerId = crypto.randomUUID();
    const activePlayerId = crypto.randomUUID();
    await db.insert(serverInstances).values({
      id: instanceId,
      groupId,
      variantId,
      lifecycleState: "RUNNING",
      availabilityState: "OPEN",
      endpoint: "localhost:25565",
      playerCount: 2,
    });
    await db.insert(gameSessions).values({
      id: sessionId,
      groupId,
      instanceId,
      state: "RUNNING",
      startedAt: new Date(),
    });
    await db.update(serverInstances)
      .set({ sessionId, availabilityState: "RESERVED" })
      .where(eq(serverInstances.id, instanceId));
    await db.insert(sessionPlayers).values([
      {
        sessionId,
        playerId: eliminatedPlayerId,
        partyId: "original-party",
        state: "CONNECTED",
      },
      {
        sessionId,
        playerId: activePlayerId,
        partyId: "original-party",
        state: "CONNECTED",
      },
    ]);
    await db.insert(instancePlayers).values([
      {
        instanceId,
        playerId: eliminatedPlayerId,
        staleDeadline: new Date(Date.now() + 30_000),
      },
      {
        instanceId,
        playerId: activePlayerId,
        staleDeadline: new Date(Date.now() + 30_000),
      },
    ]);
    const queues = new QueueService(db);
    const controller = new InstanceController(
      db,
      {} as Executor,
      {} as VariantSelector,
      {} as RedisEventBus,
      {} as TransferService,
      {} as HubRouter,
      mockLogger,
    );

    await expect(queues.enqueue({
      groupId,
      partyId: "next-party",
      players: [eliminatedPlayerId],
    })).rejects.toThrow("already matchmaking");

    await controller.handlePaperEvent(instanceId, {
      type: "PLAYER_ELIMINATED",
      sessionId,
      playerId: eliminatedPlayerId,
    });
    const released = await db.select().from(sessionPlayers).where(and(
      eq(sessionPlayers.sessionId, sessionId),
      eq(sessionPlayers.playerId, eliminatedPlayerId),
    ));
    const connected = await db.select().from(instancePlayers).where(
      eq(instancePlayers.instanceId, instanceId),
    );
    const revised = await db.select().from(gameSessions).where(eq(gameSessions.id, sessionId));
    expect(released[0]!.state).toBe("LEFT");
    expect(released[0]!.leftAt).not.toBeNull();
    expect(connected.map((player) => player.playerId).toSorted()).toEqual(
      [activePlayerId, eliminatedPlayerId].toSorted(),
    );
    expect(revised[0]!.assignmentRevision).toBe(2);

    const requeued = await queues.enqueue({
      groupId,
      partyId: "changed-party",
      players: [eliminatedPlayerId],
    });
    expect(requeued.state).toBe("QUEUED");
    await expect(queues.enqueue({
      groupId,
      partyId: "still-playing",
      players: [activePlayerId],
    })).rejects.toThrow("already matchmaking");

    await controller.handlePaperEvent(instanceId, {
      type: "HEARTBEAT",
      playerIds: [eliminatedPlayerId, activePlayerId],
    });
    await controller.handlePaperEvent(instanceId, {
      type: "PLAYER_ELIMINATED",
      sessionId,
      playerId: eliminatedPlayerId,
    });
    const afterHeartbeat = await db.select().from(sessionPlayers).where(and(
      eq(sessionPlayers.sessionId, sessionId),
      eq(sessionPlayers.playerId, eliminatedPlayerId),
    ));
    const afterRetry = await db.select().from(gameSessions).where(eq(gameSessions.id, sessionId));
    expect(afterHeartbeat[0]!.state).toBe("LEFT");
    expect(afterRetry[0]!.assignmentRevision).toBe(2);
  });

  test("PLAYER_ELIMINATED rejects invalid session ownership, state and membership", async () => {
    const { groupId, variantId } = await seedGroup();
    const instanceId = nanoid();
    const sessionId = nanoid();
    const playerId = crypto.randomUUID();
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
    });
    await db.update(serverInstances)
      .set({ sessionId, availabilityState: "RESERVED" })
      .where(eq(serverInstances.id, instanceId));
    await db.insert(sessionPlayers).values({
      sessionId,
      playerId,
      partyId: "waiting-party",
      state: "CONNECTED",
    });
    const controller = new InstanceController(
      db,
      {} as Executor,
      {} as VariantSelector,
      {} as RedisEventBus,
      {} as TransferService,
      {} as HubRouter,
      mockLogger,
    );

    await expect(controller.handlePaperEvent(instanceId, {
      type: "PLAYER_ELIMINATED",
      sessionId,
      playerId,
    })).rejects.toThrow("unavailable");
    await db.update(gameSessions).set({ state: "RUNNING" }).where(eq(gameSessions.id, sessionId));
    await expect(controller.handlePaperEvent(instanceId, {
      type: "PLAYER_ELIMINATED",
      sessionId,
      playerId: crypto.randomUUID(),
    })).rejects.toThrow("unavailable");
    await expect(controller.handlePaperEvent(instanceId, {
      type: "PLAYER_ELIMINATED",
      sessionId: nanoid(),
      playerId,
    })).rejects.toThrow("unavailable");
    await expect(controller.handlePaperEvent(nanoid(), {
      type: "PLAYER_ELIMINATED",
      sessionId,
      playerId,
    })).rejects.toThrow("unavailable");
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
      drainTimeoutMs: 60_000,
      cancelledDrainTimeoutMs: 10_000,
      shutdownTimeoutMs: 20_000,
      transferTimeoutMs: 20_000,
      playerStaleTimeoutMs: 30_000,
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
      staleDeadline: new Date(Date.now() + 30_000),
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
      new HubRouter(db, evacuationTransfers),
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

  test("hub routing balances batches across groups and is idempotent", async () => {
    const { groupId, variantId } = await seedGroup();
    const sourceInstanceId = nanoid();
    await db.insert(serverInstances).values({
      id: sourceInstanceId,
      groupId,
      variantId,
      lifecycleState: "RUNNING",
      availabilityState: "OPEN",
      endpoint: "game:25565",
    });

    const hubGroups = ["hub-one", "hub-two"];
    const hubInstances: string[] = [];
    for (const [index, hubGroupId] of hubGroups.entries()) {
      const hubVariantId = `${hubGroupId}-variant`;
      const hubInstanceId = nanoid();
      await db.insert(serverGroups).values({
        id: hubGroupId,
        type: "hub",
        enabled: true,
        minimumInstances: 1,
        maximumInstances: 4,
        minimumWarmInstances: 1,
        maximumWarmInstances: 2,
        maximumPlayersPerInstance: 100,
        targetPlayersPerInstance: 70,
        startupTimeoutMs: 60_000,
        drainTimeoutMs: 60_000,
        cancelledDrainTimeoutMs: 10_000,
        shutdownTimeoutMs: 20_000,
        transferTimeoutMs: 20_000,
        playerStaleTimeoutMs: 30_000,
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
      await db.insert(serverInstances).values({
        id: hubInstanceId,
        groupId: hubGroupId,
        variantId: hubVariantId,
        lifecycleState: "RUNNING",
        availabilityState: "OPEN",
        endpoint: `${hubGroupId}:25565`,
        playerCount: index === 0 ? 10 : 10,
      });
      hubInstances.push(hubInstanceId);
    }

    const overloadedGroupId = "hub-overloaded";
    const overloadedVariantId = "hub-overloaded-variant";
    const overloadedInstanceId = nanoid();
    await db.insert(serverGroups).values({
      id: overloadedGroupId,
      type: "hub",
      enabled: true,
      minimumInstances: 1,
      maximumInstances: 4,
      minimumWarmInstances: 1,
      maximumWarmInstances: 2,
      maximumPlayersPerInstance: 100,
      targetPlayersPerInstance: 70,
      startupTimeoutMs: 60_000,
      drainTimeoutMs: 60_000,
      cancelledDrainTimeoutMs: 10_000,
      shutdownTimeoutMs: 20_000,
      transferTimeoutMs: 20_000,
      playerStaleTimeoutMs: 30_000,
    });
    await db.insert(serverVariants).values({
      id: overloadedVariantId,
      groupId: overloadedGroupId,
      templatePath: "none",
      enabled: true,
      revision: 1,
      selectionWeight: 100,
      checksum: "none",
      runtimeSpec: {},
    });
    await db.insert(serverInstances).values({
      id: overloadedInstanceId,
      groupId: overloadedGroupId,
      variantId: overloadedVariantId,
      lifecycleState: "RUNNING",
      availabilityState: "OPEN",
      endpoint: "hub-overloaded:25565",
      playerCount: 75,
    });

    const playerIds = Array.from({ length: 5 }, () => crypto.randomUUID());
    await db.insert(instancePlayers).values(playerIds.map((playerId) => ({
      instanceId: sourceInstanceId,
      playerId,
      staleDeadline: new Date(Date.now() + 30_000),
    })));
    await db.insert(transferCommands).values({
      id: nanoid(),
      instanceId: hubInstances[0]!,
      payload: {
        instanceId: hubInstances[0]!,
        endpoint: "hub-one:25565",
        players: [crypto.randomUUID()],
      },
      expiresAt: new Date(Date.now() + 20_000),
    });

    const durableTransfers = {
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
    const router = new HubRouter(db, durableTransfers);
    const first = await router.transferPlayers(sourceInstanceId, playerIds);
    const second = await router.transferPlayers(sourceInstanceId, playerIds);

    expect(first.acceptedPlayers.toSorted()).toEqual(playerIds.toSorted());
    expect(first.rejectedPlayers).toEqual([]);
    expect(second.acceptedPlayers.toSorted()).toEqual(playerIds.toSorted());
    const commands = await db.select().from(transferCommands);
    expect(commands).toHaveLength(3);
    const routed = commands
      .map((command) => command.payload as { instanceId: string; players: string[] })
      .filter((payload) => playerIds.some((playerId) => payload.players.includes(playerId)));
    expect(routed).toHaveLength(2);
    expect(routed.every((payload) => payload.instanceId !== overloadedInstanceId)).toBeTrue();
    expect(routed.flatMap((payload) => payload.players).toSorted()).toEqual(
      playerIds.toSorted(),
    );
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

  test("renews an expired hub only after strict capacity becomes available", async () => {
    const groupId = "renewing-hub";
    const variantId = "renewing-hub-v2";
    await db.insert(serverGroups).values({
      id: groupId,
      type: "hub",
      enabled: true,
      minimumInstances: 0,
      maximumInstances: 3,
      minimumWarmInstances: 0,
      maximumWarmInstances: 3,
      maximumPlayersPerInstance: 100,
      targetPlayersPerInstance: 70,
      startupTimeoutMs: 60_000,
      drainTimeoutMs: 300_000,
      cancelledDrainTimeoutMs: 10_000,
      shutdownTimeoutMs: 20_000,
      transferTimeoutMs: 20_000,
      playerStaleTimeoutMs: 30_000,
      instanceLifetimeMs: 1_000,
    });
    await db.insert(serverVariants).values({
      id: variantId,
      groupId,
      templatePath: "none",
      enabled: true,
      revision: 2,
      selectionWeight: 100,
      checksum: "renewal",
      runtimeSpec: {
        image: "itzg/minecraft-server:java25",
        memoryBytes: 1024,
        cpu: 1,
        environment: {},
      },
    });

    const sourceInstanceId = nanoid();
    const secondExpiredInstanceId = nanoid();
    const occupyingInstanceId = nanoid();
    await db.insert(serverInstances).values([
      {
        id: sourceInstanceId,
        groupId,
        variantId,
        lifecycleState: "RUNNING",
        availabilityState: "OPEN",
        endpoint: "old-hub:25565",
        runningAt: new Date(Date.now() - 60_000),
        renewalDeadline: new Date(Date.now() - 30_000),
      },
      {
        id: secondExpiredInstanceId,
        groupId,
        variantId,
        lifecycleState: "RUNNING",
        availabilityState: "OPEN",
        endpoint: "second-old-hub:25565",
        runningAt: new Date(Date.now() - 30_000),
        renewalDeadline: new Date(Date.now() - 10_000),
      },
      {
        id: occupyingInstanceId,
        groupId,
        variantId,
        lifecycleState: "RUNNING",
        availabilityState: "OPEN",
        endpoint: "other-hub:25565",
        runningAt: new Date(),
        renewalDeadline: new Date(Date.now() + 60_000),
      },
    ]);

    const executor = {
      createInstance: mock(async (spec) => ({
        containerId: `container-${spec.instanceId}`,
        runtimePath: `runtime/${spec.instanceId}`,
        endpoint: `${spec.instanceId}:25565`,
      })),
      stopInstance: mock(async () => {}),
      deleteInstance: mock(async () => {}),
      deleteOrphanInstance: mock(async () => ({
        containerRemoved: true,
        runtimeDirectoryRemoved: true,
      })),
      inspectInstance: mock(async () => ({ exists: true, running: true })),
      listManagedInstances: mock(async () => []),
    } as Executor;
    const registryEvents: Array<{ type: string; instanceId: string }> = [];
    const bus = {
      publishRegistry: mock(async (type: string, payload: { instanceId: string }) => {
        registryEvents.push({ type, instanceId: payload.instanceId });
      }),
    } as unknown as RedisEventBus;
    const controller = new InstanceController(
      db,
      executor,
      new VariantSelector(db),
      bus,
      mockTransfers,
      new HubRouter(db, mockTransfers),
      mockLogger,
    );
    const capacity = new CapacityController(db, controller, mockLogger);

    await capacity.tick();
    let active = await db.select().from(serverInstances)
      .where(inArray(serverInstances.lifecycleState, ["CREATING", "STARTING", "RUNNING", "DRAINING"]));
    expect(active).toHaveLength(3);
    expect(active.some((instance) => instance.replacesInstanceId === sourceInstanceId)).toBeFalse();

    await db.update(serverInstances)
      .set({ lifecycleState: "STOPPED" })
      .where(eq(serverInstances.id, occupyingInstanceId));
    await capacity.tick();

    active = await db.select().from(serverInstances)
      .where(inArray(serverInstances.lifecycleState, ["CREATING", "STARTING", "RUNNING", "DRAINING"]));
    expect(active).toHaveLength(3);
    const replacement = active.find(
      (instance) => instance.replacesInstanceId === sourceInstanceId,
    );
    expect(replacement?.lifecycleState).toBe("STARTING");

    await controller.handlePaperEvent(replacement!.id, {
      type: "SERVER_READY",
      endpoint: "new-hub:25565",
    });

    const [source, ready] = await Promise.all([
      db.select().from(serverInstances).where(eq(serverInstances.id, sourceInstanceId)),
      db.select().from(serverInstances).where(eq(serverInstances.id, replacement!.id)),
    ]);
    expect(source[0]?.lifecycleState).toBe("DRAINING");
    expect(source[0]?.drainReason).toBe("HUB_RENEWAL");
    expect(ready[0]?.lifecycleState).toBe("RUNNING");
    expect(ready[0]?.renewalDeadline?.getTime()).toBeGreaterThan(Date.now());
    expect(registryEvents.slice(-2)).toEqual([
      { type: "SERVER_REGISTERED", instanceId: replacement!.id },
      { type: "SERVER_UNREGISTERED", instanceId: sourceInstanceId },
    ]);

    await capacity.tick();
    const activeReplacements = await db.select().from(serverInstances)
      .where(
        inArray(serverInstances.lifecycleState, ["CREATING", "STARTING", "RUNNING"]),
      );
    expect(
      activeReplacements.filter((instance) => instance.replacesInstanceId !== null),
    ).toHaveLength(1);
  });

  test("reconciler removes an orphan once and records one successful cleanup", async () => {
    const orphan: RuntimeInstance = {
      instanceId: "orphanInstance01",
      containerId: "orphan-container-01",
      groupId: "missing-group",
      variantId: "missing-variant",
      running: true,
      status: "Up",
    };
    let runtimeInstances: RuntimeInstance[] = [orphan];
    const deleteOrphanInstance = mock(async (instance: RuntimeInstance) => {
      runtimeInstances = runtimeInstances.filter(
        (candidate) => candidate.containerId !== instance.containerId,
      );
      return { containerRemoved: true, runtimeDirectoryRemoved: true };
    });
    const executor = {
      listManagedInstances: mock(async () => runtimeInstances),
      deleteOrphanInstance,
    } as unknown as Executor;
    const reconciler = new Reconciler(db, executor, {} as InstanceController, mockLogger);

    await reconciler.tick();
    await reconciler.tick();

    expect(deleteOrphanInstance).toHaveBeenCalledTimes(1);
    const audit = await db.select().from(events);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.type).toBe("ORPHAN_DISCOVERED");
    expect(audit[0]?.payload).toEqual({
      ...orphan,
      cleanup: { containerRemoved: true, runtimeDirectoryRemoved: true },
    });
  });

  test("reconciler preserves an instance that becomes active before orphan cleanup", async () => {
    const { groupId, variantId } = await seedGroup();
    const instanceId = "raceInstance0001";
    await db.insert(serverInstances).values({
      id: instanceId,
      groupId,
      variantId,
      lifecycleState: "STOPPED",
      availabilityState: "OPEN",
    });
    const orphan: RuntimeInstance = {
      instanceId,
      containerId: "race-container",
      groupId,
      variantId,
      running: true,
      status: "Up",
    };
    const deleteOrphanInstance = mock(async () => ({
      containerRemoved: true,
      runtimeDirectoryRemoved: true,
    }));
    const executor = {
      listManagedInstances: mock(async () => {
        await Bun.sleep(50);
        await db.update(serverInstances)
          .set({ lifecycleState: "RUNNING" })
          .where(eq(serverInstances.id, instanceId));
        return [orphan];
      }),
      deleteOrphanInstance,
    } as unknown as Executor;
    const reconciler = new Reconciler(db, executor, {} as InstanceController, mockLogger);

    await reconciler.tick();

    expect(deleteOrphanInstance).not.toHaveBeenCalled();
    expect(await db.select().from(events)).toHaveLength(0);
  });

  test("reconciler cleans a container whose persisted instance is stopped", async () => {
    const { groupId, variantId } = await seedGroup();
    const instanceId = "stoppedInstance1";
    await db.insert(serverInstances).values({
      id: instanceId,
      groupId,
      variantId,
      lifecycleState: "STOPPED",
      availabilityState: "OPEN",
    });
    const stoppedRuntime: RuntimeInstance = {
      instanceId,
      containerId: "stopped-container",
      groupId,
      variantId,
      running: false,
      status: "Exited",
    };
    const deleteOrphanInstance = mock(async () => ({
      containerRemoved: true,
      runtimeDirectoryRemoved: true,
    }));
    const executor = {
      listManagedInstances: mock(async () => [stoppedRuntime]),
      deleteOrphanInstance,
    } as unknown as Executor;
    const reconciler = new Reconciler(db, executor, {} as InstanceController, mockLogger);

    await reconciler.tick();

    expect(deleteOrphanInstance).toHaveBeenCalledWith(stoppedRuntime);
  });

  test("reconciler isolates cleanup failures and retries only remaining orphans", async () => {
    const first: RuntimeInstance = {
      instanceId: "firstOrphan00001",
      containerId: "first-container",
      groupId: "missing",
      variantId: "missing",
      running: true,
      status: "Up",
    };
    const second: RuntimeInstance = {
      ...first,
      instanceId: "secondOrphan0001",
      containerId: "second-container",
    };
    let runtimeInstances = [first, second];
    let firstAttempts = 0;
    const deleteOrphanInstance = mock(async (instance: RuntimeInstance) => {
      if (instance.containerId === first.containerId && firstAttempts++ === 0) {
        throw new Error("temporary Docker failure");
      }
      runtimeInstances = runtimeInstances.filter(
        (candidate) => candidate.containerId !== instance.containerId,
      );
      return { containerRemoved: true, runtimeDirectoryRemoved: true };
    });
    const executor = {
      listManagedInstances: mock(async () => runtimeInstances),
      deleteOrphanInstance,
    } as unknown as Executor;
    const silentLogger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    } as unknown as Logger;
    const reconciler = new Reconciler(db, executor, {} as InstanceController, silentLogger);

    await reconciler.tick();
    await reconciler.tick();

    expect(deleteOrphanInstance.mock.calls.map(([instance]) => instance.containerId)).toEqual([
      "first-container",
      "second-container",
      "first-container",
    ]);
    expect(await db.select().from(events)).toHaveLength(2);
    expect(runtimeInstances).toHaveLength(0);
  });
});
