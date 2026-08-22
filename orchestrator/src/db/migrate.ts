import { migrate } from "drizzle-orm/postgres-js/migrator";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.ts";
import { createDatabase } from "./client.ts";
import { Logger } from "../logger.ts";

// Apply pending schema migrations before any service starts reading state.
export async function migrateDatabase(databaseUrl: string, logger?: Logger): Promise<void> {
  const { db, sql } = createDatabase(databaseUrl);
  await migrate(db, {
    migrationsFolder: fileURLToPath(new URL("../../migrations", import.meta.url)),
  });
  await sql.end();
  logger?.info("database.migrations.applied", "Database migrations applied");
}

if (import.meta.main) {
  const config = loadConfig();
  const logger = new Logger(config.logLevel, { service: "orchestrator", version: "0.1.0" });
  await migrateDatabase(config.databaseUrl, logger);
  process.exit(0);
}
