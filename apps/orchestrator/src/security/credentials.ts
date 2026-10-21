import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { ApplicationError } from "@endercloud/contracts/errors";
import type { ServicePrincipal } from "@endercloud/contracts/schemas";
import type { Database } from "../db/client.ts";
import { serviceCredentials, apikey, user } from "../db/schema.ts";
import { executionHosts, serverInstances, serverGroups, events } from "../db/schema.ts";
import { enqueueRegistryEvent } from "../events/registry-outbox.ts";
import { nanoid } from "@endercloud/runtime/id";
import { sql, inArray } from "drizzle-orm";
import type { Authentication } from "./auth.ts";
import type { SecurityConfig } from "./config.ts";

interface Secrets {
  apiToken: string;
  controlToken?: string;
}

export class Credentials {
  private readonly issuing = new Map<string, Promise<Secrets>>();
  public constructor(
    private readonly db: Database,
    private readonly auth: Authentication,
    private readonly config: SecurityConfig,
  ) {}

  private encrypt(id: string, value: Secrets): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.config.encryptionKey, nonce);
    cipher.setAAD(Buffer.from(id));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(value), "utf8"),
      cipher.final(),
    ]);
    return [
      "v1",
      nonce.toString("base64"),
      cipher.getAuthTag().toString("base64"),
      ciphertext.toString("base64"),
    ].join(".");
  }

  private decrypt(id: string, value: string): Secrets {
    const [version, nonce, tag, ciphertext] = value.split(".");
    if (version !== "v1" || !nonce || !tag || !ciphertext)
      throw new Error("Invalid credential envelope");
    const cipher = createDecipheriv(
      "aes-256-gcm",
      this.config.encryptionKey,
      Buffer.from(nonce, "base64"),
    );
    cipher.setAAD(Buffer.from(id));
    cipher.setAuthTag(Buffer.from(tag, "base64"));
    return JSON.parse(
      Buffer.concat([cipher.update(Buffer.from(ciphertext, "base64")), cipher.final()]).toString(
        "utf8",
      ),
    ) as Secrets;
  }

  public async get(kind: ServicePrincipal["kind"], principalId: string): Promise<Secrets | null> {
    const [record] = await this.db
      .select()
      .from(serviceCredentials)
      .where(eq(serviceCredentials.id, `${kind}:${principalId}`));
    return record ? this.decrypt(record.id, record.encryptedSecret) : null;
  }

  public async ensure(
    kind: ServicePrincipal["kind"],
    principalId: string,
    rotate = false,
  ): Promise<Secrets> {
    const id = `${kind}:${principalId}`;
    const pending = this.issuing.get(id);
    if (pending) return pending;
    const operation = this.issue(kind, principalId, rotate).finally(() => this.issuing.delete(id));
    this.issuing.set(id, operation);
    return operation;
  }

  private async issue(
    kind: ServicePrincipal["kind"],
    principalId: string,
    rotate: boolean,
  ): Promise<Secrets> {
    const id = `${kind}:${principalId}`;
    const existing = await this.get(kind, principalId);
    if (existing && !rotate) return existing;
    const [administrator] = await this.db.select().from(user).limit(1);
    if (!administrator)
      throw new ApplicationError(
        "CONFLICT",
        409,
        "Create the local administrator before provisioning services",
      );
    const key = await this.auth.api.createApiKey({
      body: {
        configId: "service",
        name: id,
        userId: administrator.id,
        metadata: { kind, principalId },
        rateLimitEnabled: false,
      },
    });
    const secret: Secrets = {
      apiToken: key.key,
      ...(kind === "agent" ? { controlToken: randomBytes(32).toString("base64url") } : {}),
    };
    try {
      await this.db.transaction(async (tx) => {
        const [previous] = await tx
          .select()
          .from(serviceCredentials)
          .where(eq(serviceCredentials.id, id))
          .for("update");
        if (previous && !rotate) return;
        const insert = tx.insert(serviceCredentials).values({
          id,
          kind,
          principalId,
          authKeyId: key.id,
          encryptedSecret: this.encrypt(id, secret),
        });
        if (rotate)
          await insert.onConflictDoUpdate({
            target: serviceCredentials.id,
            set: { authKeyId: key.id, encryptedSecret: this.encrypt(id, secret) },
          });
        else await insert.onConflictDoNothing();
        if (previous)
          await tx.update(apikey).set({ enabled: false }).where(eq(apikey.id, previous.authKeyId));
      });
      const [stored] = await this.db
        .select()
        .from(serviceCredentials)
        .where(eq(serviceCredentials.id, id));
      if (stored!.authKeyId !== key.id) {
        await this.db.delete(apikey).where(eq(apikey.id, key.id));
        return this.decrypt(stored!.id, stored!.encryptedSecret);
      }
      return secret;
    } catch (error) {
      await this.db
        .update(apikey)
        .set({ enabled: false })
        .where(eq(apikey.id, key.id))
        .catch(() => {});
      throw error;
    }
  }

  public async getControlToken(hostId: string): Promise<string> {
    const secret = await this.get("agent", hostId);
    if (!secret?.controlToken)
      throw new ApplicationError("FORBIDDEN", 403, "Execution host has not been provisioned");
    return secret.controlToken;
  }

  public async runtimeEnvironment(
    kind: "paper" | "proxy",
    instanceId: string,
  ): Promise<Record<string, string>> {
    const [instance] = await this.db
      .select({ state: serverInstances.lifecycleState })
      .from(serverInstances)
      .where(eq(serverInstances.id, instanceId));
    if (!instance || !["CREATING", "STARTING"].includes(instance.state))
      throw new ApplicationError(
        "CONFLICT",
        409,
        "Instance is no longer eligible for provisioning",
      );
    if (kind === "proxy" && !this.config.proxyRedisUrl)
      throw new Error("PROXY_REDIS_URL is required for managed proxies");
    return {
      ENDERCLOUD_API_TOKEN: (await this.ensure(kind, instanceId)).apiToken,
      ...(kind === "proxy" ? { ENDERCLOUD_REDIS_URL: this.config.proxyRedisUrl! } : {}),
    };
  }

  public async revoke(kind: ServicePrincipal["kind"], principalId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [record] = await tx
        .select()
        .from(serviceCredentials)
        .where(
          and(eq(serviceCredentials.kind, kind), eq(serviceCredentials.principalId, principalId)),
        )
        .for("update");
      if (record)
        await tx.update(apikey).set({ enabled: false }).where(eq(apikey.id, record.authKeyId));
      if (kind === "agent")
        await tx
          .update(executionHosts)
          .set({ healthState: "OFFLINE", updatedAt: sql`now()` })
          .where(eq(executionHosts.id, principalId));
    });
  }

  /** Replace runtime identities instead of mutating an admitted CREATE specification. */
  public async retireInstance(
    instanceId: string,
    reason: "CREDENTIAL_ROTATED" | "CREDENTIAL_REVOKED",
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .select({ id: serverGroups.id })
        .from(serverGroups)
        .where(
          sql`${serverGroups.id} = (SELECT group_id FROM server_instances WHERE id = ${instanceId})`,
        )
        .for("update");
      const [instance] = await tx
        .select()
        .from(serverInstances)
        .where(eq(serverInstances.id, instanceId))
        .for("update");
      if (!instance) throw new ApplicationError("NOT_FOUND", 404, "Instance was not found");
      await tx.update(apikey).set({ enabled: false }).where(sql`${apikey.id} IN (
        SELECT auth_key_id FROM service_credentials WHERE principal_id = ${instanceId} AND kind IN ('paper', 'proxy'))`);
      const changed = await tx
        .update(serverInstances)
        .set({
          lifecycleState: "FAILED",
          failedAt: sql`now()`,
          failureReason: reason,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(serverInstances.id, instanceId),
            inArray(serverInstances.lifecycleState, [
              "CREATING",
              "STARTING",
              "RUNNING",
              "DRAINING",
            ]),
          ),
        )
        .returning({ id: serverInstances.id });
      if (changed.length) {
        await tx.insert(events).values({
          id: nanoid(),
          aggregateType: "instance",
          aggregateId: instanceId,
          type: "INSTANCE_FAILED",
          payload: { reason },
        });
        await enqueueRegistryEvent(tx, "SERVER_UNREGISTERED", { instanceId });
      }
    });
  }
}
