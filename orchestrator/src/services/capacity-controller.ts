import type { Database } from "../db/client.ts";
import { serverGroups, serverInstances } from "../db/schema.ts";
import { and, eq, notInArray, asc, sql } from "drizzle-orm";
import { decideCapacity } from "../domain/capacity.ts";
import type { Logger } from "../logger.ts";
import type { InstanceController } from "./instance-controller.ts";

export class CapacityController {
  private running = false;

  public constructor(
    private readonly db: Database,
    private readonly instances: InstanceController,
    private readonly logger: Logger,
  ) {}

  // Reconcile every group pool with its configured warm and absolute limits.
  public async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.initializeHubRenewalDeadlines();
      const groups = await this.db.select().from(serverGroups);
      // Reconcile groups independently so one broken configuration does not block every pool.
      for (const group of groups) {
        try {
          // Select all active instances for group
          const current = await this.db
            .select({
              id: serverInstances.id,
              lifecycle_state: serverInstances.lifecycleState,
              availability_state: serverInstances.availabilityState,
              player_count: serverInstances.playerCount,
              renewal_deadline: serverInstances.renewalDeadline,
              replaces_instance_id: serverInstances.replacesInstanceId,
            })
            .from(serverInstances)
            .where(
              and(
                eq(serverInstances.groupId, group.id),
                notInArray(serverInstances.lifecycleState, [
                  "STOPPED",
                  "FAILED",
                ]),
              ),
            )
            .orderBy(
              sql`${serverInstances.runningAt} ASC NULLS LAST`,
              asc(serverInstances.createdAt),
            );

          const byId = new Map(
            current.map((instance) => [instance.id, instance]),
          );

          // Find active replacement instances
          const activeRenewals = current.filter((replacement) => {
            if (!replacement.replaces_instance_id) return false;
            const source = byId.get(replacement.replaces_instance_id);
            return source !== undefined;
          });

          // Find a ready replacement instance
          const readyReplacement = activeRenewals.find((replacement) => {
            const source = byId.get(replacement.replaces_instance_id!);
            return (
              replacement.lifecycle_state === "RUNNING" &&
              source?.lifecycle_state === "RUNNING"
            );
          });

          // If the replacement instance is ready, complete the renewal
          if (readyReplacement) {
            await this.instances.completeHubRenewal(readyReplacement.id);
            // Refresh capacity on the next tick after the durable handoff changed lifecycle state.
            continue;
          }

          // Find an active hub instance that need renewal
          const dueHub =
            group.enabled && group.type === "hub" && activeRenewals.length === 0
              ? current.find(
                  (instance) =>
                    instance.lifecycle_state === "RUNNING" &&
                    instance.availability_state === "OPEN" &&
                    instance.renewal_deadline !== null &&
                    instance.renewal_deadline.getTime() <= Date.now(),
                )
              : undefined;

          // If need renewall and we are below max instances, start renewal
          if (dueHub && current.length < group.maximumInstances) {
            const created = await this.instances.createWarm(
              group.id,
              dueHub.id,
            );

            if (created) {
              this.logger.info("Hub renewal replacement started", {
                groupId: group.id,
                sourceInstanceId: dueHub.id,
                replacementInstanceId: created,
              });
              // The renewal consumes the available slot before regular autoscaling.
              continue;
            }
          }

          const decision = decideCapacity(
            {
              minimumInstances: group.minimumInstances,
              maximumInstances: group.maximumInstances,
              minimumWarmInstances: group.minimumWarmInstances,
              maximumWarmInstances: group.maximumWarmInstances,
            },
            current.map((instance) => ({
              lifecycle: instance.lifecycle_state,
              availability: instance.availability_state,
            })),
            group.enabled,
            group.type === "hub" && group.targetPlayersPerInstance
              ? await this.requiredHubInstances(
                  group.id,
                  group.targetPlayersPerInstance,
                )
              : 0,
          );
          // Create exactly the deficit calculated by the pure capacity policy.
          for (let index = 0; index < decision.create; index += 1) {
            await this.instances.createWarm(group.id);
          }
          // Only open, fully running instances can be removed without stealing a reservation.
          const protectedInstanceIds = new Set(
            activeRenewals.flatMap((replacement) => [
              replacement.id,
              replacement.replaces_instance_id!,
            ]),
          );
          const drainCandidates = current.filter(
            (instance) =>
              instance.lifecycle_state === "RUNNING" &&
              instance.availability_state === "OPEN" &&
              !protectedInstanceIds.has(instance.id) &&
              (group.type !== "hub" ||
                !group.enabled ||
                instance.player_count === 0),
          );
          // The earlier SQL ordering makes this slice the deterministic scale-down set.
          for (const candidate of drainCandidates.slice(0, decision.drain)) {
            await this.instances.beginDrain(candidate.id);
          }
        } catch (error) {
          this.logger.error("Capacity group tick failed", {
            groupId: group.id,
            error: String(error),
          });
        }
      }
    } catch (error) {
      this.logger.error("Capacity tick failed", { error: String(error) });
    } finally {
      this.running = false;
    }
  }

  private async initializeHubRenewalDeadlines(): Promise<void> {
    await this.db
      .update(serverInstances)
      .set({
        renewalDeadline: sql`${serverInstances.runningAt}
          + (${serverGroups.instanceLifetimeMs} * interval '1 millisecond')`,
        updatedAt: sql`now()`,
      })
      .from(serverGroups)
      .where(
        and(
          eq(serverInstances.groupId, serverGroups.id),
          eq(serverGroups.type, "hub"),
          eq(serverInstances.lifecycleState, "RUNNING"),
          sql`${serverInstances.renewalDeadline} IS NULL`,
          sql`${serverInstances.runningAt} IS NOT NULL`,
          sql`${serverGroups.instanceLifetimeMs} IS NOT NULL`,
        ),
      );
  }

  private async requiredHubInstances(
    groupId: string,
    targetPlayersPerInstance: number,
  ): Promise<number> {
    const rows = await this.db
      .select({
        effectivePlayers: sql<number>`(
          SELECT count(DISTINCT demand.player_id)::int
          FROM (
            SELECT players.player_id::text AS player_id
            FROM instance_players players
            JOIN server_instances current_instance
              ON current_instance.id = players.instance_id
            WHERE current_instance.group_id = ${groupId}
              AND current_instance.lifecycle_state NOT IN ('STOPPED', 'FAILED')
            UNION
            SELECT expected.player_id
            FROM transfer_commands pending
            JOIN server_instances target_instance
              ON target_instance.id = pending.instance_id
            CROSS JOIN LATERAL
              jsonb_array_elements_text(pending.payload->'players') expected(player_id)
            WHERE target_instance.group_id = ${groupId}
              AND pending.state = 'PENDING'
              AND pending.expires_at > now()
          ) demand
        )`,
      })
      .from(serverGroups)
      .where(eq(serverGroups.id, groupId))
      .limit(1);
    const effectivePlayers = Number(rows[0]?.effectivePlayers ?? 0);
    if (effectivePlayers === 0) return 0;
    // Reaching the aggregate target starts the next instance. Creating and
    // starting instances already count as active in decideCapacity.
    return Math.floor(effectivePlayers / targetPlayersPerInstance) + 1;
  }
}
