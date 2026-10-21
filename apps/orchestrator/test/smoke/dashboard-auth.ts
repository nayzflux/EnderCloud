/** Disposable real authentication backend for dashboard browser tests. */
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { createDatabase } from "../../src/db/client.ts";
import { migrateDatabase } from "../../src/db/migrate.ts";
import { createAuth, authHttpHandler } from "../../src/security/auth.ts";
import { createAdministrator } from "../../src/security/cli.ts";

const container = await new PostgreSqlContainer("postgres:15-alpine").start();
const database = createDatabase(container.getConnectionUri());
let server: ReturnType<typeof Bun.serve> | undefined;
let closing: Promise<void> | undefined;
function close() {
  return closing ??= (async () => { server?.stop(true); await database.sql.end(); await container.stop(); })();
}
process.once("SIGTERM", () => void close());
process.once("SIGINT", () => void close());
try {
  await migrateDatabase(container.getConnectionUri());
  const config = { secret: "browser-tests-only-secret-at-least-32-bytes", encryptionKey: Buffer.alloc(32, 2), origin: "http://127.0.0.1:3100" };
  await createAdministrator(database.db, config, "browser@example.test", "browser-only-password-12345");
  const handler = authHttpHandler(createAuth(database.db, config));
  server = Bun.serve({ hostname: "127.0.0.1", port: 3180, fetch: request =>
    new URL(request.url).pathname === "/health/live" ? Response.json({ status: "UP" }) : handler(request) });
} catch (error) { await close(); throw error; }
