import { Logger } from "@endercloud/runtime/logger";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.ts";
import { createDatabase } from "./client.ts";

// Apply pending schema migrations before any service starts reading state.
export async function migrateDatabase(databaseUrl: string, logger?: Logger): Promise<void> {
  const { db, sql } = createDatabase(databaseUrl);
  let lock: Awaited<ReturnType<typeof sql.reserve>> | undefined;
  try {
    lock = await sql.reserve();
    await lock`SELECT pg_advisory_lock(18523417)`;
    const [marker] = await lock`SELECT to_regclass('public.release_metadata') AS name`;
    if (!marker?.name) {
      const tables = await lock`SELECT tablename FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema') LIMIT 1`;
      if (tables.length) throw new Error("Legacy database refused without modification. Back up existing data and configure an empty release database.");
    } else {
      const [release] = await lock`SELECT schema_version FROM release_metadata WHERE id = 1`;
      if (release?.schema_version !== 1) throw new Error("Unsupported EnderCloud database release");
    }
    await migrate(db, {
      migrationsFolder: fileURLToPath(new URL("../../migrations", import.meta.url)),
    });
  } finally {
    if (lock) {
      await lock`SELECT pg_advisory_unlock(18523417)`.catch(() => {});
      lock.release();
    }
    await sql.end({ timeout: 5 });
  }
  logger?.info("database.migrations.applied", "Database migrations applied");
}

if (import.meta.main) {
  const config = loadConfig();
  const logger = new Logger(config.logLevel, { service: "orchestrator", version: "0.1.0" });
  await migrateDatabase(config.databaseUrl, logger);
  process.exit(0);
}
