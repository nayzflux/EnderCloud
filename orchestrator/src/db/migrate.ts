import { migrate } from "drizzle-orm/postgres-js/migrator";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.ts";
import { createDatabase } from "./client.ts";

export async function migrateDatabase(databaseUrl: string): Promise<void> {
  const { db, sql } = createDatabase(databaseUrl);
  await migrate(db, {
    migrationsFolder: fileURLToPath(new URL("../../migrations", import.meta.url)),
  });
  await sql.end();
}

if (import.meta.main) {
  const config = loadConfig();
  await migrateDatabase(config.databaseUrl);
  console.log("Database migrations applied");
  process.exit(0);
}
