import type { Database } from "../db/client.ts";
import { sql, eq, and, or, isNull } from "drizzle-orm";
import {
  serverGroupVariants,
  serverInstances,
  serverVariants,
  variantStartStates,
} from "../db/schema.ts";
import type { VariantRuntimeSpec } from "../domain/types.ts";
import { selectVariant } from "../domain/variant-selection.ts";

interface VariantRow {
  id: string;
  group_id: string;
  revision: number;
  selection_weight: number;
  runtime_spec: VariantRuntimeSpec;
  warm_count: number;
}

export class VariantSelector {
  public constructor(private readonly db: Database) {}

  // Select the best enabled variant using current weighted representation.
  public async select(groupId: string): Promise<VariantRow | null> {
    const rows = (await this.db
      .select({
        id: serverVariants.id,
        group_id: serverGroupVariants.groupId,
        revision: serverVariants.revision,
        selection_weight: serverGroupVariants.selectionWeight,
        runtime_spec: serverVariants.runtimeSpec,
        warm_count: sql<number>`count(${serverInstances.id}) FILTER (
          WHERE ${serverInstances.lifecycleState} IN ('CREATING', 'STARTING', 'RUNNING')
            AND ${serverInstances.availabilityState} = 'OPEN'
        )::int`.mapWith(Number),
      })
      .from(serverGroupVariants)
      .innerJoin(serverVariants, eq(serverVariants.id, serverGroupVariants.variantId))
      .leftJoin(
        variantStartStates,
        and(
          eq(variantStartStates.groupId, serverGroupVariants.groupId),
          eq(variantStartStates.variantId, serverVariants.id),
          eq(variantStartStates.variantRevision, serverVariants.revision),
        ),
      )
      .leftJoin(
        serverInstances,
        and(
          eq(serverInstances.variantId, serverVariants.id),
          eq(serverInstances.groupId, groupId),
        ),
      )
      .where(
        and(
          eq(serverGroupVariants.groupId, groupId),
          eq(serverGroupVariants.enabled, true),
          or(
            isNull(variantStartStates.state),
            and(
              eq(variantStartStates.state, "BACKING_OFF"),
              sql`${variantStartStates.nextRetryAt} <= now()`,
            ),
          ),
          sql`NOT EXISTS (
            SELECT 1 FROM variant_start_states pending_reset
            WHERE pending_reset.group_id = ${serverGroupVariants.groupId}
              AND pending_reset.variant_id = ${serverVariants.id}
              AND pending_reset.state = 'RESETTING'
          )`,
        ),
      )
      .groupBy(
        serverVariants.id,
        serverGroupVariants.groupId,
        serverGroupVariants.selectionWeight,
        variantStartStates.state,
        variantStartStates.nextRetryAt,
      )) as unknown as VariantRow[];

    if (rows.length === 0) return null;

    const selected = selectVariant(
      rows.map((row) => ({
        id: row.id,
        weight: row.selection_weight,
        warmCount: row.warm_count,
      })),
    );
    return rows.find((row) => row.id === selected.id) ?? null;
  }
}
