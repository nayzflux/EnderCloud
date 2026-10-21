import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema.ts";

export type SqlClient = ReturnType<typeof postgres>;

// Create the shared PostgreSQL client used by all orchestrator services.
export function createDatabase(databaseUrl: string) {
  const sql = postgres(databaseUrl, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
    onnotice: () => {},
  });
  const db = drizzle(sql, { schema });
  return { sql, db };
}

export type Database = ReturnType<typeof createDatabase>["db"];
