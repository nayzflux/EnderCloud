import { z } from "zod";

const schema = z.object({
  AUTH_SECRET: z.string().min(32),
  CREDENTIAL_ENCRYPTION_KEY: z.string().refine(value => /^[A-Za-z0-9+/]+={0,2}$/.test(value) && Buffer.from(value, "base64").length === 32, "must encode 32 random bytes in base64"),
  DASHBOARD_PUBLIC_URL: z.url().refine(value => {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && url.pathname === "/" && !url.username && !url.password && !url.search && !url.hash;
  }, "must be an HTTP(S) origin"),
  PROXY_REDIS_URL: z.url().refine(value => ["redis:", "rediss:"].includes(new URL(value).protocol), "must be a Redis URL").optional(),
});

export function loadSecurityConfig(environment: Readonly<Record<string, string | undefined>> = process.env) {
  const values = schema.parse(environment);
  const origin = new URL(values.DASHBOARD_PUBLIC_URL).origin;
  if (environment.NODE_ENV === "production" && !origin.startsWith("https://") && !["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname)) {
    throw new Error("Production dashboard access requires HTTPS or a loopback development origin");
  }
  return { secret: values.AUTH_SECRET, encryptionKey: Buffer.from(values.CREDENTIAL_ENCRYPTION_KEY, "base64"), origin,
    ...(values.PROXY_REDIS_URL ? { proxyRedisUrl: values.PROXY_REDIS_URL } : {}) };
}

export type SecurityConfig = ReturnType<typeof loadSecurityConfig>;
