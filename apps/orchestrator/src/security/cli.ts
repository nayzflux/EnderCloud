import { eq, and } from "drizzle-orm";
import { hashPassword } from "better-auth/crypto";
import { createDatabase } from "../db/client.ts";
import { migrateDatabase } from "../db/migrate.ts";
import { account, session, user } from "../db/schema.ts";
import { createAuth } from "./auth.ts";
import { loadSecurityConfig } from "./config.ts";
import { Credentials } from "./credentials.ts";

export async function createAdministrator(db: ReturnType<typeof createDatabase>["db"], config: ReturnType<typeof loadSecurityConfig>, email: string, password: string) {
  return createAuth(db, config, true).api.signUpEmail({ body: { email, password, name: "Administrator" } });
}

export async function resetAdministrator(db: ReturnType<typeof createDatabase>["db"], password: string) {
  if (password.length < 14 || password.length > 128) throw new Error("Password must contain 14 to 128 characters");
  const [admin] = await db.select().from(user).limit(1);
  if (!admin) throw new Error("Administrator not initialized");
  const hashed = await hashPassword(password);
  await db.transaction(async tx => {
    await tx.update(account).set({ password: hashed }).where(and(eq(account.userId, admin.id), eq(account.providerId, "credential")));
    await tx.delete(session).where(eq(session.userId, admin.id));
  });
}

if (import.meta.main) {
  const config = loadSecurityConfig();
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const [command, identity, option] = process.argv.slice(2);
  await migrateDatabase(url);
  const database = createDatabase(url);
  const lock = await database.sql.reserve();
  try {
    await lock`SELECT pg_advisory_lock(18523418)`;
    if (command === "admin:create" || command === "admin:reset") {
      if (process.stdin.isTTY) throw new Error("Pipe the password on standard input; do not place it in command arguments");
      const password = (await Bun.stdin.text()).replace(/\r?\n$/, "");
      if (command === "admin:create") {
        if (!identity) throw new Error("An administrator email is required");
        await createAdministrator(database.db, config, identity, password);
      } else await resetAdministrator(database.db, password);
      console.log("Administrator updated; existing sessions were invalidated when resetting the password.");
    } else if (["agent:provision", "agent:rotate", "agent:revoke"].includes(command ?? "")) {
      if (!identity || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(identity)) throw new Error("A valid host id is required");
      const credentials = new Credentials(database.db, createAuth(database.db, config), config);
      if (command === "agent:revoke") await credentials.revoke("agent", identity);
      else {
        if (option !== "--stdout") throw new Error("Use --stdout and redirect to the worker's protected environment file");
        const values = await credentials.ensure("agent", identity, command === "agent:rotate");
        console.log(`AGENT_ID=${identity}\nAGENT_ORCHESTRATOR_TOKEN=${values.apiToken}\nAGENT_CONTROL_TOKEN=${values.controlToken}`);
      }
    } else throw new Error("Commands: admin:create <email>, admin:reset, agent:provision|rotate <host> --stdout, agent:revoke <host>");
  } finally {
    await lock`SELECT pg_advisory_unlock(18523418)`.catch(() => {});
    lock.release();
    await database.sql.end({ timeout: 5 });
  }
}
