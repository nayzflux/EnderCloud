import type { Database } from "../db/client.ts";
import { sql, eq, and } from "drizzle-orm";
import { serverVariants, serverInstances } from "../db/schema.ts";
import type { VariantRuntimeSpec } from "../domain/types.ts";
import { selectVariant } from "../domain/variant-selection.ts";

interface VariantRow {
  id: string;
  group_id: string;
  template_path: string;
  selection_weight: number;
  runtime_spec: VariantRuntimeSpec;
  warm_count: number;
}

export class VariantSelector {
  public constructor(private readonly db: Database) {}

  // Select the best enabled variant using current weighted representation.
  public async select(groupId: string): Promise<VariantRow> {
    const rows = await this.db
      .select({
        id: serverVariants.id,
        group_id: serverVariants.groupId,
        template_path: serverVariants.templatePath,
        selection_weight: serverVariants.selectionWeight,
        runtime_spec: serverVariants.runtimeSpec,
        warm_count: sql<number>`count(${serverInstances.id}) FILTER (
          WHERE ${serverInstances.lifecycleState} IN ('CREATING', 'STARTING', 'RUNNING')
            AND ${serverInstances.availabilityState} = 'OPEN'
        )::int`.mapWith(Number),
      })
      .from(serverVariants)
      .leftJoin(serverInstances, eq(serverInstances.variantId, serverVariants.id))
      .where(
        and(
          eq(serverVariants.groupId, groupId),
          eq(serverVariants.enabled, true),
        ),
      )
      .groupBy(serverVariants.id) as unknown as VariantRow[];

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
