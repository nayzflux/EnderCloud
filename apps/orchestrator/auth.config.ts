// Schema generation only; the production entry point constructs authentication explicitly.
import { createAuth } from "./src/security/auth.ts";
import { loadSecurityConfig } from "./src/security/config.ts";
import { createDatabase } from "./src/db/client.ts";

export const auth = createAuth(createDatabase(process.env.DATABASE_URL!).db, loadSecurityConfig());
