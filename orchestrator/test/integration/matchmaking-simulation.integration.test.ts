import { describe, expect, test, beforeAll, beforeEach, afterAll, mock } from "bun:test";
import { createDatabase, type SqlClient } from "../../src/db/client.ts";
import { migrateDatabase } from "../../src/db/migrate.ts";
import { Matchmaker } from "../../src/services/matchmaker.ts";
import { QueueService } from "../../src/services/queue-service.ts";
import { serverGroups, serverGroupVariants, serverVariantLayers, serverVariants, templateLayers, serverInstances, gameSessions, sessionPlayers, queueEntries } from "../../src/db/schema.ts";
import type { TransferService } from "../../src/services/transfer-service.ts";
import type { Logger } from "../../src/logger.ts";
import { nanoid } from "../../src/id.ts";
import { eq, count } from "drizzle-orm";
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
  cancelForInstance: mock(async () => {}),
  tick: mock(async () => {}),
} as unknown as TransferService;

let container: StartedPostgreSqlContainer | undefined;
let sql: ReturnType<typeof createDatabase>["sql"];
let db: ReturnType<typeof createDatabase>["db"];
let matchmaker: Matchmaker;
let queueService: QueueService;

async function cleanDb() {
  await sql`TRUNCATE TABLE template_layers, server_groups CASCADE`;
}

describe("Mega Simulation End-to-End Matchmaking", () => {
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
    queueService = new QueueService(db);
  }, 30000); // Allow time for container to download and start

  beforeEach(async () => {
    await cleanDb();
    (mockTransfers.enqueue as any).mockClear();
  });

  afterAll(async () => {
    if (sql) await sql.end();
    if (container) await container.stop();
  });

  test("Simulates a stress test with 50 players, backfill, disconnections, and autoscaling", async () => {
    console.log("-> Start 1. Initialization");
    // ---------------------------------------------------------
    // 1. Base infrastructure initialization
    // ---------------------------------------------------------
    const groupId = "skywars-mega";
    const variantId = "mega-variant";
    
    await db.insert(serverGroups).values({
      id: groupId,
      type: "minigame",
      enabled: true,
      minimumPlayers: 8,
      maximumPlayers: 16,
      teamCount: 4,
      teamSize: 4,
      instanceAcquisitionTimeoutMs: 30000,
      lobbyStaleTimeoutMs: 90000,
      minimumInstances: 0,
      maximumInstances: 10,
      minimumWarmInstances: 0,
      maximumWarmInstances: 2,
      startupTimeoutMs: 60000,
      drainTimeoutMs: 60000,
      cancelledDrainTimeoutMs: 10000,
      shutdownTimeoutMs: 60000,
      transferTimeoutMs: 20000,
      playerStaleTimeoutMs: 30000,
    });
    
    const runtime = {
      image: "itzg/minecraft-server:java25",
      memoryBytes: 1024,
      cpu: 1,
      environment: {},
    };
    await db.insert(templateLayers).values({
      id: variantId,
      templatePath: "none",
      checksum: "none",
      runtimePatch: runtime,
      fileSummary: { fileCount: 0, totalBytes: 0, roots: [] },
    });
    await db.insert(serverVariants).values({
      id: variantId,
      revision: 1,
      checksum: "none",
      runtimeSpec: runtime,
    });
    await db.insert(serverVariantLayers).values({ variantId, layerId: variantId, ordinal: 0 });
    await db.insert(serverGroupVariants).values({
      groupId,
      variantId,
      enabled: true,
      selectionWeight: 100,
    });

    const warmInstanceId = nanoid();
    await db.insert(serverInstances).values({
      id: warmInstanceId,
      groupId,
      variantId,
      lifecycleState: "RUNNING",
      availabilityState: "OPEN",
      endpoint: "localhost:25565",
    });

    console.log("-> Start 2. Player Avalanche");
    // ---------------------------------------------------------
    // 2. Player Avalanche (QueueService)
    // ---------------------------------------------------------
    // We aim for around 50 players.
    
    // a) Rejection test: Party too large
    const tooLarge = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    try {
      await queueService.enqueue({ groupId, partyId: nanoid(), players: tooLarge });
      throw new Error("Should have thrown");
    } catch (e: any) {
      expect(e.message).toBe("The party is larger than a team");
    }

    // b) Normal queue filling
    let enqueuedPlayersCount = 0;
    
    async function enqueueParty(size: number) {
      const players = Array.from({ length: size }, () => crypto.randomUUID());
      await queueService.enqueue({ groupId, partyId: nanoid(), players });
      enqueuedPlayersCount += size;
      return players;
    }

    console.log("-> Enqueue Party 1-4");
    // 4 parties of 4 = 16 players (Should fill session 1)
    const party1 = await enqueueParty(4);
    await enqueueParty(4);
    await enqueueParty(4);
    await enqueueParty(4);
    
    console.log("-> Enqueue Party 5-9");
    // 5 parties of 4 = 20 players (Should fill session 2 + session 3)
    await enqueueParty(4);
    await enqueueParty(4);
    await enqueueParty(4);
    await enqueueParty(4);
    await enqueueParty(4); // This one will go into session 3
    
    console.log("-> Enqueue Party 10-15");
    // 6 parties of 2 = 12 players (Should fill session 3 and leave 2 players in queue)
    await enqueueParty(2);
    await enqueueParty(2);
    await enqueueParty(2);
    await enqueueParty(2);
    await enqueueParty(2);
    await enqueueParty(2);
    
    expect(enqueuedPlayersCount).toBe(16 + 20 + 12); // 48 players
    
    console.log("-> Start 3. Matchmaker Tick");
    // ---------------------------------------------------------
    // 3. First Tick (Fast Start)
    // ---------------------------------------------------------
    await matchmaker.tick();
    console.log("-> End Matchmaker Tick 1");
    
    const sessionsStep1 = await db.select().from(gameSessions);
    expect(sessionsStep1).toHaveLength(3); // 3 sessions created!
    
    const activeSession = sessionsStep1.find((s: any) => s.state === "TRANSFERRING");
    expect(activeSession).toBeDefined();
    expect(activeSession?.instanceId).toBe(warmInstanceId);
    
    const waitingSessions = sessionsStep1.filter((s: any) => s.state === "WAITING_FOR_INSTANCE");
    expect(waitingSessions).toHaveLength(2);
    
    // The session reserves at the minimum (8), then the two remaining tickets are
    // backfilled with their own durable transfer command.
    expect(mockTransfers.enqueue).toHaveBeenCalledTimes(3);
    (mockTransfers.enqueue as any).mockClear();
    
    console.log("-> Start 4. Disconnection");
    // ---------------------------------------------------------
    // 4. Player disconnected before departure
    // ---------------------------------------------------------
    // We take a player from the first session
    const leaverId = party1[0] as string;
    
    // Simulates a network disconnect from the proxy
    await queueService.networkDisconnected(leaverId);
    
    // Verify their state is 'LEFT' in session_players
    const playerRecord = await db.select().from(sessionPlayers).where(eq(sessionPlayers.playerId, leaverId));
    expect(playerRecord[0]!.state).toBe("LEFT");

    console.log("-> Start 5. Backfill");
    // ---------------------------------------------------------
    // 5. Solo player arrival and Backfill
    // ---------------------------------------------------------
    // There are now 15/16 players in the warm instance.
    const soloPlayer = await enqueueParty(1);
    
    await matchmaker.tick();
    console.log("-> End Matchmaker Tick 2");
    
    // The solo player must have filled the empty spot (Backfill)
    const soloRecord = await db.select().from(sessionPlayers).where(eq(sessionPlayers.playerId, soloPlayer[0] as string));
    expect(soloRecord[0]!.sessionId).toBe(activeSession!.id);
    expect(soloRecord[0]!.state).toBe("TRANSFERRING"); // Immediately transferring since the instance is warm
    
    // A new transfer command was emitted (only for them)
    expect(mockTransfers.enqueue).toHaveBeenCalledTimes(1);
    (mockTransfers.enqueue as any).mockClear();

    console.log("-> Start 6. Autoscaling");
    // ---------------------------------------------------------
    // 6. Autoscaling & Cold Start Resolution
    // ---------------------------------------------------------
    // The orchestrator requests 2 new instances from the cloud provider
    const instanceCold1 = nanoid();
    const instanceCold2 = nanoid();
    
    await db.insert(serverInstances).values([
      {
        id: instanceCold1,
        groupId,
        variantId,
        lifecycleState: "RUNNING",
        availabilityState: "OPEN",
        endpoint: "localhost:25566",
      },
      {
        id: instanceCold2,
        groupId,
        variantId,
        lifecycleState: "RUNNING",
        availabilityState: "OPEN",
        endpoint: "localhost:25567",
      }
    ]);
    
    // Tick! The WAITING_FOR_INSTANCE sessions will claim the warm instances
    await matchmaker.tick();
    console.log("-> End Matchmaker Tick 3");
    
    const sessionsFinal = await db.select().from(gameSessions);
    // No sessions should be waiting anymore
    const remainingWaiting = sessionsFinal.filter((s: any) => s.state === "WAITING_FOR_INSTANCE");
    expect(remainingWaiting).toHaveLength(0);
    
    const transferring = sessionsFinal.filter((s: any) => s.state === "TRANSFERRING");
    expect(transferring).toHaveLength(3); // All 3 sessions are transferring
    
    // Transfer commands sent for the two newly bound sessions
    expect(mockTransfers.enqueue).toHaveBeenCalledTimes(2);

    console.log("-> Start 7. Verifications");
    // ---------------------------------------------------------
    // 7. Final integrity checks
    // ---------------------------------------------------------
    // There must be exactly 49 active players in session_players 
    // (48 + 1 solo, all 'TRANSFERRING' except 1 'LEFT')
    const finalPlayers = await db.select().from(sessionPlayers);
    expect(finalPlayers).toHaveLength(49);
    
    const leftPlayers = finalPlayers.filter((p: any) => p.state === "LEFT");
    expect(leftPlayers).toHaveLength(1);
    expect(leftPlayers[0]!.playerId).toBe(leaverId);

    const transferringPlayers = finalPlayers.filter((p: any) => p.state === "TRANSFERRING");
    expect(transferringPlayers).toHaveLength(48);

    const finalQueue = await db.select({ count: count() }).from(queueEntries).where(eq(queueEntries.state, "QUEUED"));
    expect(finalQueue[0]!.count).toBe(0); // Empty queue
    console.log("-> End test");
  });
});
