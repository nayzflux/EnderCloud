import { createCommandSchema, type CreateCommandPayload } from "./create-spec.ts";
import { ApplicationError } from "@endercloud/contracts/errors";
import type { ServerSnapshot } from "@endercloud/contracts/domain";
import type { Executor } from "@endercloud/contracts/executor";
import {
  ExecutionHostUnavailableError,
  ExecutionCommandSupersededError,
} from "@endercloud/contracts/executor";
import { nanoid } from "@endercloud/runtime/id";
import type { Logger } from "@endercloud/runtime/logger";
import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Database } from "../../db/client.ts";
import {
  commands,
  events,
  gameSessions,
  registryState,
  apikey,
  serverGroups,
  serverGroupVariants,
  serverInstances,
  serverVariantLayers,
  serverVariants,
  templateLayers,
} from "../../db/schema.ts";
import { countsAsStartupFailure } from "../../domain/startup-policy.ts";
import type { RedisEventBus } from "../../events/redis-bus.ts";
import { enqueueRegistryEvent, readRegistryServers } from "../../events/registry-outbox.ts";
import type { HostService } from "../hosts/service.ts";
import type { MonitoringService } from "../monitoring/metrics.ts";
import type { HubRouter } from "../routing/hubs.ts";
import type { TransferService } from "../transfers/service.ts";
import type { VariantStartController } from "./start-policy.ts";
import type { VariantSelector } from "./variant-selector.ts";

import { PaperEvents } from "../sessions/paper-events.ts";

export class InstanceController {
  private readonly paperEvents: PaperEvents;
  public constructor(
    private readonly db: Database,
    private readonly executor: Executor,
    private readonly variants: VariantSelector,
    private readonly bus: RedisEventBus,
    private readonly transfers: TransferService,
    private readonly hubs: HubRouter,
    private readonly logger: Logger,
    private readonly monitoring?: MonitoringService,
    private readonly hosts?: HostService,
    private readonly startPolicy?: VariantStartController,
    private readonly paperHealthLeaseMs = 30_000,
    private readonly credentials?: import("../../security/credentials.ts").Credentials,
  ) {
    this.paperEvents = new PaperEvents(
      db,
      transfers,
      hubs,
      logger,
      monitoring,
      paperHealthLeaseMs,
      {
        markReady: (id, endpoint) => this.markReady(id, endpoint),
        beginDrain: (id, reason) => this.beginDrain(id, reason),
        publishRoutingUpdate: (id) => this.publishRoutingUpdate(id),
        evacuateCancelledMinigame: (id) => this.evacuateCancelledMinigame(id),
      },
    );
  }

  public handlePaperEvent(...args: Parameters<PaperEvents["handlePaperEvent"]>) {
    return this.paperEvents.handlePaperEvent(...args);
  }
  public getAssignment(...args: Parameters<PaperEvents["getAssignment"]>) {
    return this.paperEvents.getAssignment(...args);
  }
  public acknowledgeAssignment(...args: Parameters<PaperEvents["acknowledgeAssignment"]>) {
    return this.paperEvents.acknowledgeAssignment(...args);
  }

  // Move an instance into the shared failure path and remove it from proxy routing.
  public async failInstance(
    instanceId: string,
    reason: string,
    details: Readonly<Record<string, unknown>> = {},
    commandId?: string,
  ): Promise<boolean> {
    const changed = await this.db.transaction(async (tx) => {
      await tx
        .select({ id: serverGroups.id })
        .from(serverGroups)
        .where(
          sql`${serverGroups.id} = (SELECT group_id FROM server_instances WHERE id = ${instanceId})`,
        )
        .for("update");
      const rows = await tx
        .update(serverInstances)
        .set({
          lifecycleState: "FAILED",
          failedAt: sql`now()`,
          failureReason: reason,
          failureDetails: details,
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
        .returning({
          id: serverInstances.id,
          runningAt: serverInstances.runningAt,
        });
      if (commandId)
        await tx
          .update(commands)
          .set({
            state: "FAILED",
            completedAt: sql`now()`,
            lastError: typeof details.error === "string" ? details.error : reason,
          })
          .where(
            and(
              eq(commands.id, commandId),
              eq(commands.instanceId, instanceId),
              eq(commands.operation, "CREATE"),
              inArray(commands.state, ["PENDING", "RUNNING"]),
            ),
          );
      if (rows.length === 0) return null;
      await tx.insert(events).values({
        id: nanoid(),
        aggregateType: "instance",
        aggregateId: instanceId,
        type: "INSTANCE_FAILED",
        payload: { reason, ...details },
      });
      const startupFailure = countsAsStartupFailure(reason, rows[0]!.runningAt !== null);
      const state =
        startupFailure && this.startPolicy
          ? await this.startPolicy.recordFailure(instanceId, reason, tx)
          : null;
      const [group] = await tx
        .select({ type: serverGroups.type })
        .from(serverInstances)
        .innerJoin(serverGroups, eq(serverGroups.id, serverInstances.groupId))
        .where(eq(serverInstances.id, instanceId));
      if (group?.type !== "proxy")
        await enqueueRegistryEvent(tx, "SERVER_UNREGISTERED", { instanceId });
      return { ...rows[0]!, startupFailure, state };
    });
    if (!changed) return false;
    const { startupFailure, state } = changed;
    if (startupFailure && this.startPolicy) {
      if (state && (state.state !== "BLOCKED" || state.lastFailedInstanceId !== instanceId)) {
        await this.stopAndDelete(instanceId);
      } else if (state?.state === "BLOCKED") {
        await this.startPolicy.retainFinalRuntime(instanceId);
      }
    }
    const failureFields = { instanceId, reason, details };
    if (startupFailure) {
      this.logger.info("instance.lifecycle.failed", "Instance entered failed state", failureFields);
    } else if (reason === "HOST_OFFLINE") {
      this.logger.warn(
        "instance.lifecycle.host_lost",
        "Instance host became unavailable",
        failureFields,
      );
    } else {
      this.logger.error(
        "instance.lifecycle.failed",
        "Instance entered failed state",
        failureFields,
      );
    }
    return true;
  }

  // Create an unassigned warm instance for the requested server group.
  public async createWarm(
    groupId: string,
    replacesInstanceId?: string,
    replacementReason: "HUB_RENEWAL" | "HOST_MAINTENANCE" = "HUB_RENEWAL",
  ): Promise<string | null> {
    const variant = await this.variants.select(groupId);
    if (!variant) {
      this.logger.debug(
        "capacity.variant.unavailable",
        "No variant revision is eligible for startup",
        { groupId },
      );
      return null;
    }
    const instanceId = nanoid();
    // Track deletion separately so failed cleanup is visible and retryable.
    const commandId = nanoid();
    // Persist the desired instance and its command before touching Docker. This
    // makes creation recoverable if the orchestrator crashes between the two steps.
    const persisted = await this.db.transaction(async (tx) => {
      const groups = await tx
        .select({
          enabled: serverGroups.enabled,
          maximum_instances: serverGroups.maximumInstances,
          type: serverGroups.type,
        })
        .from(serverGroups)
        .where(eq(serverGroups.id, groupId))
        .for("update");
      const group = groups[0];
      if (!group?.enabled) return false;

      const currentVariants = await tx
        .select({
          revision: serverVariants.revision,
          checksum: serverVariants.checksum,
          runtime: serverVariants.runtimeSpec,
        })
        .from(serverVariants)
        .innerJoin(serverGroupVariants, eq(serverGroupVariants.variantId, serverVariants.id))
        .where(
          and(
            eq(serverVariants.id, variant.id),
            eq(serverGroupVariants.groupId, groupId),
            eq(serverGroupVariants.enabled, true),
          ),
        );
      const currentVariant = currentVariants[0];
      if (
        !currentVariant ||
        currentVariant.revision !== variant.revision ||
        currentVariant.checksum !== variant.checksum
      )
        return false;
      const selectedLayers = await tx
        .select({
          id: templateLayers.id,
          checksum: templateLayers.checksum,
        })
        .from(serverVariantLayers)
        .innerJoin(templateLayers, eq(templateLayers.id, serverVariantLayers.layerId))
        .where(eq(serverVariantLayers.variantId, variant.id))
        .orderBy(asc(serverVariantLayers.ordinal));
      if (selectedLayers.length === 0) {
        throw new Error(`Variant ${variant.id} has no materialization layers`);
      }
      const createPayload: CreateCommandPayload = {
        instanceType: group.type === "proxy" ? "proxy" : "paper",
        version: 1,
        variantRevision: currentVariant.revision,
        variantChecksum: currentVariant.checksum,
        runtime: currentVariant.runtime,
        templateLayers: selectedLayers,
      };

      const capacityLimit =
        group.maximum_instances +
        (replacesInstanceId && replacementReason === "HOST_MAINTENANCE" ? 1 : 0);

      let sourceHostId: string | undefined;
      if (replacesInstanceId) {
        const sourceConditions = [
          eq(serverInstances.id, replacesInstanceId),
          eq(serverInstances.groupId, groupId),
          eq(serverInstances.lifecycleState, "RUNNING"),
          sql`(${serverInstances.paperHealthDeadline} IS NULL OR ${serverInstances.paperHealthDeadline} > now())`,
          eq(serverInstances.availabilityState, "OPEN"),
        ];
        if (replacementReason === "HUB_RENEWAL") {
          if (group.type !== "hub") return false;
          sourceConditions.push(sql`${serverInstances.renewalDeadline} <= now()`);
        } else {
          sourceConditions.push(sql`EXISTS (
            SELECT 1 FROM execution_hosts maintenance_host
            WHERE maintenance_host.id = ${serverInstances.hostId}
              AND maintenance_host.admin_state = 'DRAINING'
          )`);
        }
        const sources = await tx
          .select({ id: serverInstances.id, host_id: serverInstances.hostId })
          .from(serverInstances)
          .where(and(...sourceConditions));
        if (!sources[0]) return false;
        sourceHostId = sources[0].host_id ?? undefined;
        const activeReplacements = await tx
          .select({ id: serverInstances.id })
          .from(serverInstances)
          .where(
            and(
              eq(serverInstances.groupId, groupId),
              isNotNull(serverInstances.replacesInstanceId),
              inArray(serverInstances.lifecycleState, ["CREATING", "STARTING", "RUNNING"]),
              sql`EXISTS (
                SELECT 1
                FROM server_instances source
                WHERE source.id = ${serverInstances.replacesInstanceId}
                  AND source.lifecycle_state NOT IN ('STOPPED', 'FAILED')
              )`,
            ),
          )
          .limit(1);
        if (activeReplacements[0]) return false;
      }

      if (!this.hosts) throw new Error("Host service is required for instance placement");
      const placement = await this.hosts.selectForPlacement(
        tx,
        createPayload.runtime,
        replacementReason === "HOST_MAINTENANCE" ? sourceHostId : undefined,
        { groupId, maximumInstances: capacityLimit },
        createPayload.instanceType,
      );
      if (placement.status === "BLOCKED") return false;
      const hostId = placement.hostId;

      await tx.insert(serverInstances).values({
        id: instanceId,
        groupId: groupId,
        variantId: variant.id,
        variantRevision: variant.revision,
        hostId,
        reservedCpu: createPayload.runtime.cpu,
        reservedMemoryBytes: createPayload.runtime.memoryBytes,
        lifecycleState: "CREATING",
        availabilityState: "OPEN",
        replacesInstanceId: replacesInstanceId ?? null,
        replacementReason: replacesInstanceId ? replacementReason : null,
      });
      if (
        this.startPolicy &&
        !(await this.startPolicy.reserveAttempt(
          tx,
          groupId,
          variant.id,
          variant.revision,
          instanceId,
        ))
      ) {
        await tx.delete(serverInstances).where(eq(serverInstances.id, instanceId));
        return false;
      }
      await tx.insert(commands).values({
        id: commandId,
        instanceId: instanceId,
        operation: "CREATE",
        state: "PENDING",
        payload: createPayload,
      });
      return true;
    });
    if (!persisted) return null;
    this.logger.info("instance.start.planned", "Instance startup planned", {
      instanceId,
      commandId,
      groupId,
      variantId: variant.id,
      revision: variant.revision,
    });
    return instanceId;
  }

  // Resume an interrupted CREATE command from persisted state.
  public async resumeCreate(instanceId: string): Promise<void> {
    // Use the newest CREATE command because older attempts may describe an already-retried operation.
    const cmds = await this.db
      .select({ id: commands.id })
      .from(commands)
      .where(and(eq(commands.instanceId, instanceId), eq(commands.operation, "CREATE")))
      .orderBy(desc(commands.createdAt))
      .limit(1);
    if (!cmds[0]) await this.failInstance(instanceId, "MISSING_CREATE_COMMAND");
  }

  // Execute the recoverable database-to-Docker creation workflow.
  public async executeCreate(
    instanceId: string,
    commandId: string,
    interrupted: () => boolean = () => false,
  ): Promise<void> {
    const rows = await this.db
      .select({
        id: serverInstances.id,
        host_id: serverInstances.hostId,
        group_id: serverInstances.groupId,
        variant_id: serverInstances.variantId,
        session_id: serverInstances.sessionId,
        variant_revision: serverInstances.variantRevision,
        reserved_cpu: serverInstances.reservedCpu,
        reserved_memory_bytes: serverInstances.reservedMemoryBytes,
        command_payload: commands.payload,
        group_enabled: serverGroups.enabled,
      })
      .from(serverInstances)
      .innerJoin(serverGroups, eq(serverGroups.id, serverInstances.groupId))
      .innerJoin(commands, eq(commands.instanceId, serverInstances.id))
      .where(
        and(
          eq(serverInstances.id, instanceId),
          eq(commands.id, commandId),
          inArray(serverInstances.lifecycleState, ["CREATING", "STARTING"]),
        ),
      );
    const row = rows[0];
    if (!row) {
      await this.db
        .update(commands)
        .set({
          state: "FAILED",
          completedAt: sql`now()`,
          lastError: "Instance is no longer eligible for creation",
        })
        .where(eq(commands.id, commandId));
      return;
    }
    if (!row.host_id) {
      await this.failInstance(instanceId, "MISSING_EXECUTION_HOST", {}, commandId);
      return;
    }
    const snapshot = createCommandSchema.safeParse(row.command_payload);
    const frozen = snapshot.success ? snapshot.data : null;
    const availableLayers = frozen
      ? await this.db
          .select({
            id: templateLayers.id,
            checksum: templateLayers.checksum,
          })
          .from(templateLayers)
          .where(
            inArray(
              templateLayers.id,
              frozen.templateLayers.map((layer) => layer.id),
            ),
          )
      : [];
    const layerChecksums = new Map(availableLayers.map((layer) => [layer.id, layer.checksum]));
    if (
      !row.group_enabled ||
      !frozen ||
      (frozen &&
        (frozen.variantRevision !== row.variant_revision ||
          frozen.runtime.cpu !== row.reserved_cpu ||
          frozen.runtime.memoryBytes !== row.reserved_memory_bytes)) ||
      (frozen &&
        frozen.templateLayers.some((layer) => layerChecksums.get(layer.id) !== layer.checksum))
    ) {
      await this.db.transaction(async (tx) => {
        await tx
          .update(commands)
          .set({
            state: "CANCELLED",
            completedAt: sql`now()`,
            lastError: "Stored CREATE specification is incompatible with the reserved instance",
          })
          .where(eq(commands.id, commandId));
        await tx
          .update(serverInstances)
          .set({
            lifecycleState: "FAILED",
            failedAt: sql`now()`,
            failureReason: row.group_enabled ? "OBSOLETE_CREATE" : "GROUP_DISABLED",
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(serverInstances.id, instanceId),
              inArray(serverInstances.lifecycleState, ["CREATING", "STARTING"]),
            ),
          );
      });
      return;
    }
    // Local SQL and credential failures stay recoverable; only remote execution can fail a variant.
    const environment = this.credentials
      ? await this.credentials.runtimeEnvironment(frozen.instanceType, instanceId)
      : {};
    let created: Awaited<ReturnType<Executor["createInstance"]>>;
    try {
      // Executor creation is idempotent: an existing managed container is reused
      // when reconciliation resumes a partially completed CREATE command.
      created = await this.executor.createInstance({
        instanceType: frozen.instanceType,
        hostId: row.host_id,
        instanceId: row.id,
        groupId: row.group_id,
        variantId: row.variant_id,
        ...(row.session_id ? { sessionId: row.session_id } : {}),
        templateLayers: frozen.templateLayers,
        runtime: frozen.runtime,
        environment,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (interrupted()) {
        await this.db
          .update(commands)
          .set({
            state: "PENDING",
            startedAt: null,
            lastError: null,
          })
          .where(eq(commands.id, commandId));
        this.logger.info(
          "instance.start.interrupted",
          "Instance startup returned to the pending queue",
          {
            instanceId,
            commandId,
          },
        );
        return;
      }
      const reason =
        error instanceof ExecutionHostUnavailableError
          ? "HOST_OFFLINE"
          : error instanceof ExecutionCommandSupersededError
            ? "OBSOLETE_CREATE"
            : "CREATE_FAILED";
      await this.failInstance(instanceId, reason, { error: message }, commandId);
      const failureFields = {
        instanceId,
        commandId,
        hostId: row.host_id,
        reason,
        error,
      };
      if (reason === "HOST_OFFLINE") {
        this.logger.warn(
          "instance.start.host_unavailable",
          "Instance creation was interrupted by an unavailable host",
          failureFields,
        );
      } else {
        this.logger.error("instance.start.failed", "Instance creation failed", failureFields);
      }
      return;
    }
    await this.db.transaction(async (tx) => {
      await tx
        .update(serverInstances)
        .set({
          lifecycleState: "STARTING",
          startingAt: sql`COALESCE(${serverInstances.startingAt}, now())`,
          startupDeadline: sql`now() + (
            (SELECT startup_timeout_ms FROM server_groups WHERE id = ${row.group_id})
            * interval '1 millisecond'
          )`,
          containerId: created.containerId,
          runtimePath: created.runtimePath,
          endpoint: created.endpoint,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(serverInstances.id, instanceId),
            inArray(serverInstances.lifecycleState, ["CREATING", "STARTING"]),
          ),
        );
      await tx
        .update(commands)
        .set({
          state: "SUCCEEDED",
          completedAt: sql`now()`,
          lastError: null,
        })
        .where(eq(commands.id, commandId));
    });
    this.logger.info("instance.start.requested", "Execution agent started the instance container", {
      instanceId,
      commandId,
      hostId: row.host_id,
      groupId: row.group_id,
      variantId: row.variant_id,
      containerId: created.containerId,
    });
  }

  public async abandonTransfer(
    commandId: string,
    playerId: string,
    generation: number,
  ): Promise<void> {
    await this.transfers.abandon(commandId, playerId, generation);
  }

  public async suspectHealth(instanceId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const changed = await tx
        .update(serverInstances)
        .set({ healthSuspectedAt: sql`now()` })
        .where(
          and(
            eq(serverInstances.id, instanceId),
            eq(serverInstances.lifecycleState, "RUNNING"),
            sql`${serverInstances.paperHealthDeadline} <= now()`,
            sql`${serverInstances.healthSuspectedAt} IS NULL`,
          ),
        )
        .returning({ id: serverInstances.id });
      if (changed.length) await enqueueRegistryEvent(tx, "SERVER_UNREGISTERED", { instanceId });
    });
  }

  // Promote a starting instance to RUNNING and register it with proxies.
  public async markReady(instanceId: string, reportedEndpoint?: string): Promise<void> {
    const rows = await this.db.transaction(async (tx) => {
      await tx
        .select({ id: serverGroups.id })
        .from(serverGroups)
        .where(
          sql`${serverGroups.id} = (SELECT group_id FROM server_instances WHERE id = ${instanceId})`,
        )
        .for("update");
      const rows = await tx
        .update(serverInstances)
        .set({
          lifecycleState: "RUNNING",
          paperHealthDeadline: new Date(Date.now() + this.paperHealthLeaseMs),
          healthSuspectedAt: null,
          endpoint: sql`COALESCE(${reportedEndpoint ?? null}, ${serverInstances.endpoint})`,
          runningAt: sql`COALESCE(${serverInstances.runningAt}, now())`,
          renewalDeadline: sql`CASE
          WHEN ${serverGroups.type} = 'hub' THEN
            now() + (${serverGroups.instanceLifetimeMs} * interval '1 millisecond')
          ELSE NULL
        END`,
          updatedAt: sql`now()`,
        })
        .from(serverGroups)
        .where(
          and(
            eq(serverInstances.id, instanceId),
            eq(serverInstances.groupId, serverGroups.id),
            eq(serverInstances.lifecycleState, "STARTING"),
          ),
        )
        .returning({
          instanceId: serverInstances.id,
          variantId: serverInstances.variantId,
          groupId: serverInstances.groupId,
          groupType: serverGroups.type,
          endpoint: serverInstances.endpoint,
          lifecycleState: serverInstances.lifecycleState,
          availabilityState: serverInstances.availabilityState,
          playerCount: serverInstances.playerCount,
          maximumPlayers: sql<number>`COALESCE(${serverGroups.maximumPlayersPerInstance}, ${serverGroups.maximumPlayers}, 0)`,
          replacesInstanceId: serverInstances.replacesInstanceId,
          replacementReason: serverInstances.replacementReason,
        });
      if (rows[0]) {
        await this.startPolicy?.markReady(instanceId, tx);
        if (rows[0].groupType !== "proxy")
          await enqueueRegistryEvent(tx, "SERVER_REGISTERED", rows[0]);
      }
      return rows;
    });
    if (rows[0]) {
      this.logger.info("instance.lifecycle.ready", "Instance reported server readiness", {
        instanceId,
        groupId: rows[0].groupId,
        variantId: rows[0].variantId,
        endpoint: rows[0].endpoint,
      });
      if (rows[0].replacesInstanceId) {
        await this.completeReplacement(instanceId);
      }
      return;
    }
    // A repeated SERVER_READY is valid; distinguish idempotency from an invalid lifecycle.
    const current = await this.db
      .select({
        lifecycle_state: serverInstances.lifecycleState,
        replaces_instance_id: serverInstances.replacesInstanceId,
      })
      .from(serverInstances)
      .where(eq(serverInstances.id, instanceId));
    if (current[0]?.lifecycle_state !== "RUNNING") {
      throw new ApplicationError("CONFLICT", 409, `Instance ${instanceId} is unavailable`);
    }
    if (current[0].replaces_instance_id) {
      await this.completeReplacement(instanceId);
    }
  }

  // Resume the durable handoff when a replacement became ready before the old hub drained.
  public async completeHubRenewal(replacementInstanceId: string): Promise<boolean> {
    return this.completeReplacement(replacementInstanceId);
  }

  public async completeReplacement(replacementInstanceId: string): Promise<boolean> {
    const replacements = await this.db
      .select({
        instanceId: serverInstances.id,
        variantId: serverInstances.variantId,
        groupId: serverInstances.groupId,
        groupType: serverGroups.type,
        endpoint: serverInstances.endpoint,
        lifecycleState: serverInstances.lifecycleState,
        availabilityState: serverInstances.availabilityState,
        playerCount: serverInstances.playerCount,
        maximumPlayers: sql<number>`COALESCE(${serverGroups.maximumPlayersPerInstance}, 0)`,
        replacesInstanceId: serverInstances.replacesInstanceId,
        replacementReason: serverInstances.replacementReason,
      })
      .from(serverInstances)
      .innerJoin(serverGroups, eq(serverGroups.id, serverInstances.groupId))
      .where(
        and(
          eq(serverInstances.id, replacementInstanceId),
          eq(serverInstances.lifecycleState, "RUNNING"),
          sql`(${serverInstances.paperHealthDeadline} IS NULL OR ${serverInstances.paperHealthDeadline} > now())`,
          isNotNull(serverInstances.endpoint),
          isNotNull(serverInstances.replacesInstanceId),
        ),
      )
      .limit(1);
    const replacement = replacements[0];
    if (!replacement?.replacesInstanceId) return false;

    const sources = await this.db
      .select({ id: serverInstances.id })
      .from(serverInstances)
      .where(
        and(
          eq(serverInstances.id, replacement.replacesInstanceId),
          eq(serverInstances.groupId, replacement.groupId),
          eq(serverInstances.lifecycleState, "RUNNING"),
          sql`(${serverInstances.paperHealthDeadline} IS NULL OR ${serverInstances.paperHealthDeadline} > now())`,
        ),
      )
      .limit(1);
    if (!sources[0]) return false;

    // Re-registration is idempotent and closes the crash window between registration and drain.
    if (replacement.groupType !== "proxy") {
      await this.publishRegistry("SERVER_REGISTERED", replacement);
    }
    return this.beginDrain(
      replacement.replacesInstanceId,
      replacement.replacementReason === "HOST_MAINTENANCE" ? "HOST_MAINTENANCE" : "HUB_RENEWAL",
    );
  }

  // Remove an eligible instance from routing and start its drain deadline.
  public async beginDrain(
    instanceId: string,
    reason: "NORMAL" | "SESSION_CANCELLED" | "HUB_RENEWAL" | "HOST_MAINTENANCE" = "NORMAL",
  ): Promise<boolean> {
    const rows = await this.db
      .update(serverInstances)
      .set({
        lifecycleState: "DRAINING",
        drainingAt: sql`now()`,
        drainReason: reason,
        drainDeadline:
          reason === "SESSION_CANCELLED"
            ? sql`now() + (${serverGroups.cancelledDrainTimeoutMs} * interval '1 millisecond')`
            : sql`now() + (${serverGroups.drainTimeoutMs} * interval '1 millisecond')`,
        updatedAt: sql`now()`,
      })
      .from(serverGroups)
      .where(
        and(
          eq(serverInstances.id, instanceId),
          eq(serverInstances.groupId, serverGroups.id),
          eq(serverInstances.lifecycleState, "RUNNING"),
          sql`(${serverInstances.paperHealthDeadline} IS NULL OR ${serverInstances.paperHealthDeadline} > now())`,
          sql`(
          ${serverInstances.availabilityState} = 'OPEN'
          OR EXISTS (
            SELECT 1 FROM game_sessions s
            WHERE s.id = ${serverInstances.sessionId}
              AND s.state IN ('FINISHED', 'CANCELLED', 'FAILED')
          )
        )`,
        ),
      )
      .returning({ id: serverInstances.id });
    if (rows.length > 0) {
      // Remove routing before waiting for players to leave, preventing new joins during drain.
      await this.unregisterBackend(instanceId);
      await this.evacuateCancelledMinigame(instanceId);
      return true;
    }
    return false;
  }

  // Actively move every player out of a cancelled minigame, retrying safely until it is empty.
  public async evacuateCancelledMinigame(sourceInstanceId: string): Promise<number> {
    const source = await this.db
      .select({ id: serverInstances.id })
      .from(serverInstances)
      .innerJoin(serverGroups, eq(serverGroups.id, serverInstances.groupId))
      .innerJoin(gameSessions, eq(gameSessions.id, serverInstances.sessionId))
      .where(
        and(
          eq(serverInstances.id, sourceInstanceId),
          eq(serverInstances.lifecycleState, "DRAINING"),
          eq(serverGroups.type, "minigame"),
          eq(gameSessions.state, "CANCELLED"),
        ),
      )
      .limit(1);
    if (!source[0]) return 0;
    const result = await this.hubs.transferConnectedPlayers(sourceInstanceId, "SESSION_CANCELLED");
    const moved = result.acceptedPlayers.length;
    if (moved > 0) {
      this.logger.info("instance.evacuation.scheduled", "Cancelled minigame evacuation scheduled", {
        instanceId: sourceInstanceId,
        playerCount: moved,
      });
    }
    return moved;
  }

  // Converge a terminal instance to STOPPED and clean its runtime resources.
  public async stopAndDelete(instanceId: string): Promise<void> {
    const rows = await this.db
      .update(serverInstances)
      .set({
        lifecycleState: "STOPPING",
        stoppingAt: sql`COALESCE(${serverInstances.stoppingAt}, now())`,
        shutdownDeadline: sql`now() + (${serverGroups.shutdownTimeoutMs} * interval '1 millisecond')`,
        updatedAt: sql`now()`,
      })
      .from(serverGroups)
      .where(
        and(
          eq(serverInstances.id, instanceId),
          eq(serverInstances.groupId, serverGroups.id),
          inArray(serverInstances.lifecycleState, ["DRAINING", "FAILED", "ORPHANED", "STOPPING"]),
        ),
      )
      .returning({
        id: serverInstances.id,
        host_id: serverInstances.hostId,
        shutdown_timeout_ms: serverGroups.shutdownTimeoutMs,
      });
    const row = rows[0];
    if (!row) return;
    if (!row.host_id) throw new Error(`Instance ${instanceId} has no execution host`);
    const commandId = nanoid();
    await this.db.insert(commands).values({
      id: commandId,
      instanceId: instanceId,
      operation: "DELETE",
      state: "RUNNING",
    });
    try {
      // Give Minecraft its configured graceful shutdown window before forcing removal.
      const target = { hostId: row.host_id, instanceId };
      await this.executor.stopInstance(target, Math.ceil(row.shutdown_timeout_ms / 1_000));
      await this.executor.deleteInstance(target);
      await this.db.transaction(async (tx) => {
        await tx
          .update(serverInstances)
          .set({
            lifecycleState: "STOPPED",
            stoppedAt: sql`now()`,
            containerId: null,
            runtimePath: null,
            updatedAt: sql`now()`,
          })
          .where(eq(serverInstances.id, instanceId));
        await tx.update(apikey).set({ enabled: false }).where(sql`${apikey.id} IN (
          SELECT auth_key_id FROM service_credentials WHERE principal_id = ${instanceId} AND kind IN ('paper', 'proxy'))`);
        await tx
          .update(commands)
          .set({ state: "SUCCEEDED", completedAt: sql`now()` })
          .where(eq(commands.id, commandId));
      });
      await this.unregisterBackend(instanceId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.db
        .update(commands)
        .set({ state: "FAILED", completedAt: sql`now()`, lastError: message })
        .where(eq(commands.id, commandId));
      this.logger.error("instance.delete.failed", "Instance deletion failed", {
        instanceId,
        commandId,
        error,
      });
    }
  }

  // Return all running endpoints that may be registered by a proxy.
  public async listProxyServers(): Promise<readonly ServerSnapshot[]> {
    return readRegistryServers(this.db);
  }

  public async getRegistrySnapshot() {
    return this.db.transaction(async (tx) => {
      const [state] = await tx
        .select()
        .from(registryState)
        .where(eq(registryState.id, 1))
        .for("update");
      return { revision: state!.revision, servers: await readRegistryServers(tx) };
    });
  }

  private async publishRegistry(
    type: "SERVER_REGISTERED" | "SERVER_UPDATED" | "SERVER_UNREGISTERED",
    payload: unknown,
  ): Promise<void> {
    await this.db.transaction((tx) => enqueueRegistryEvent(tx, type, payload));
  }

  private async publishRoutingUpdate(instanceId: string): Promise<void> {
    const rows = await this.db
      .select({
        instanceId: serverInstances.id,
        variantId: serverInstances.variantId,
        groupId: serverInstances.groupId,
        groupType: serverGroups.type,
        endpoint: serverInstances.endpoint,
        lifecycleState: serverInstances.lifecycleState,
        availabilityState: serverInstances.availabilityState,
        playerCount: serverInstances.playerCount,
        maximumPlayers: sql<number>`COALESCE(${serverGroups.maximumPlayersPerInstance}, ${serverGroups.maximumPlayers}, 0)`,
      })
      .from(serverInstances)
      .innerJoin(serverGroups, eq(serverGroups.id, serverInstances.groupId))
      .where(
        and(
          eq(serverInstances.id, instanceId),
          inArray(serverGroups.type, ["hub", "minigame"]),
          eq(serverInstances.lifecycleState, "RUNNING"),
          sql`(${serverInstances.paperHealthDeadline} IS NULL OR ${serverInstances.paperHealthDeadline} > now())`,
          isNotNull(serverInstances.endpoint),
        ),
      )
      .limit(1);
    if (!rows[0]) return;
    try {
      await this.publishRegistry("SERVER_UPDATED", rows[0]);
    } catch (error) {
      this.logger.warn("instance.routing_update.failed", "Unable to publish server load update", {
        instanceId,
        error,
      });
    }
  }

  // Proxy instances never enter the backend registry, including during cleanup.
  private async unregisterBackend(instanceId: string): Promise<void> {
    const [instance] = await this.db
      .select({ type: serverGroups.type })
      .from(serverInstances)
      .innerJoin(serverGroups, eq(serverGroups.id, serverInstances.groupId))
      .where(eq(serverInstances.id, instanceId));
    if (instance && instance.type !== "proxy") {
      await this.publishRegistry("SERVER_UNREGISTERED", { instanceId });
    }
  }
}
