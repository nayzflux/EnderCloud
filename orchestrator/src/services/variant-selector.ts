import type { SqlClient } from "../db/client.ts";
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
  public constructor(private readonly sql: SqlClient) {}

  public async select(groupId: string): Promise<VariantRow> {
    const rows = await this.sql<VariantRow[]>`
      SELECT
        v.id, v.group_id, v.template_path, v.selection_weight, v.runtime_spec,
        count(i.id) FILTER (
          WHERE i.lifecycle_state IN ('CREATING', 'STARTING', 'RUNNING')
            AND i.availability_state = 'OPEN'
        )::int AS warm_count
      FROM server_variants v
      LEFT JOIN server_instances i ON i.variant_id = v.id
      WHERE v.group_id = ${groupId} AND v.enabled = true
      GROUP BY v.id
    `;
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
