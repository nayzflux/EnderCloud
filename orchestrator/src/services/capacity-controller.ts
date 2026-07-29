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
      const groups = await this.db.select().from(serverGroups);
      // Reconcile groups independently so one broken configuration does not block every pool.
      for (const group of groups) {
        try {
          const current = await this.db
            .select({
              id: serverInstances.id,
              lifecycle_state: serverInstances.lifecycleState,
              availability_state: serverInstances.availabilityState,
              player_count: serverInstances.playerCount,
            })
            .from(serverInstances)
            .where(
              and(
                eq(serverInstances.groupId, group.id),
                notInArray(serverInstances.lifecycleState, ['STOPPED', 'FAILED'])
              )
            )
            .orderBy(
              sql`${serverInstances.runningAt} ASC NULLS LAST`,
              asc(serverInstances.createdAt)
            );
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
          const drainCandidates = current.filter(
            (instance) =>
              instance.lifecycle_state === "RUNNING" &&
              instance.availability_state === "OPEN" &&
              (
                group.type !== "hub" ||
                !group.enabled ||
                instance.player_count === 0
              ),
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
