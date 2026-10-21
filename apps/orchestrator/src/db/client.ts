import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.ts";

export type SqlClient = ReturnType<typeof postgres>;

// Create the shared PostgreSQL client used by all orchestrator services.
export function createDatabase(databaseUrl: string) {
  const sql = postgres(databaseUrl, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
    connection: { statement_timeout: 15_000, idle_in_transaction_session_timeout: 15_000 },
    onnotice: () => {},
  });
  const db = drizzle(sql, { schema });
  return { sql, db };
}

export type Database = ReturnType<typeof createDatabase>["db"];
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
/** Explicit result contract for SQL expressions that Drizzle cannot infer. */
export type SqlRow<T extends object> = T & Record<string, unknown>;
