import type { Database } from "../db/client.ts";
import { sql, eq, and } from "drizzle-orm";
import {
  serverGroupVariants,
  serverInstances,
  serverVariants,
} from "../db/schema.ts";
import type { VariantRuntimeSpec } from "../domain/types.ts";
import { selectVariant } from "../domain/variant-selection.ts";

interface VariantRow {
  id: string;
  group_id: string;
  selection_weight: number;
  runtime_spec: VariantRuntimeSpec;
  warm_count: number;
}

export class VariantSelector {
  public constructor(private readonly db: Database) {}

  // Select the best enabled variant using current weighted representation.
  public async select(groupId: string): Promise<VariantRow> {
    const rows = (await this.db
      .select({
        id: serverVariants.id,
        group_id: serverGroupVariants.groupId,
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
        ),
      )
      .groupBy(serverVariants.id, serverGroupVariants.groupId, serverGroupVariants.selectionWeight)) as unknown as VariantRow[];

    const selected = selectVariant(
      rows.map((row) => ({
        id: row.id,
        weight: row.selection_weight,
        warmCount: row.warm_count,
      })),
    );
    return rows.find((row) => row.id === selected.id)!;
  }
}
