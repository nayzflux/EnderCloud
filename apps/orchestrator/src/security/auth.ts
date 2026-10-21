import { betterAuth } from "better-auth/minimal";
import { apiKey } from "@better-auth/api-key";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { sql } from "drizzle-orm";
import { APIError } from "better-auth/api";
import type { Database } from "../db/client.ts";
import * as schema from "../db/schema.ts";
import type { SecurityConfig } from "./config.ts";

export function createAuth(db: Database, config: SecurityConfig, bootstrap = false) {
  return betterAuth({
    secret: config.secret,
    baseURL: config.origin,
    basePath: "/api/auth",
    trustedOrigins: [config.origin],
    database: drizzleAdapter(db, { provider: "pg", schema, transaction: true }),
    emailAndPassword: {
      enabled: true,
      disableSignUp: !bootstrap,
      autoSignIn: false,
      minPasswordLength: 14,
      maxPasswordLength: 128,
    },
    session: {
      expiresIn: 8 * 60 * 60,
      disableSessionRefresh: true,
      cookieCache: { enabled: false },
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      customRules: {
        "/sign-in/email": { window: 60, max: 5 },
        // Layouts, data routes and open tabs all validate their persisted session.
        "/get-session": false,
      },
    },
    advanced: {
      useSecureCookies: config.origin.startsWith("https:"),
      cookiePrefix: "endercloud",
      defaultCookieAttributes: { httpOnly: true, sameSite: "strict" },
    },
    databaseHooks: {
      user: {
        create: {
          before: async () => {
            if (!bootstrap)
              throw new APIError("FORBIDDEN", { message: "Public registration is disabled" });
            const users = await db.execute(sql`SELECT id FROM "user" LIMIT 1`);
            if (users.length)
              throw new APIError("CONFLICT", { message: "An administrator already exists" });
          },
        },
      },
    },
    plugins: [
      apiKey({
        configId: "service",
        enableMetadata: true,
        enableSessionForAPIKeys: false,
        defaultPrefix: "ec_",
        rateLimit: { enabled: false },
      }),
    ],
  });
}

export type Authentication = ReturnType<typeof createAuth>;

/** Expose only the authentication operations needed by the single-admin console. */
export function authHttpHandler(auth: Authentication) {
  const paths = new Map([
    ["/api/auth/sign-in/email", "POST"],
    ["/api/auth/sign-out", "POST"],
    ["/api/auth/get-session", "GET"],
  ]);
  return async (request: Request): Promise<Response> => {
    if (paths.get(new URL(request.url).pathname) !== request.method)
      return Response.json({ error: "NOT_FOUND", message: "Not found" }, { status: 404 });
    return auth.handler(request);
  };
}
