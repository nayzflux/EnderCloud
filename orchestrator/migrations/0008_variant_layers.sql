CREATE TABLE "template_layers" (
  "id" text PRIMARY KEY,
  "template_path" text NOT NULL,
  "checksum" text NOT NULL,
  "runtime_patch" jsonb NOT NULL,
  "file_summary" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

INSERT INTO "template_layers" (
  "id", "template_path", "checksum", "runtime_patch", "file_summary", "created_at", "updated_at"
)
SELECT
  "id",
  "template_path",
  "checksum",
  "runtime_spec",
  '{"fileCount":0,"totalBytes":0,"roots":[]}'::jsonb,
  "created_at",
  "updated_at"
FROM "server_variants";

CREATE TABLE "server_group_variants" (
  "group_id" text NOT NULL REFERENCES "server_groups"("id") ON DELETE CASCADE,
  "variant_id" text NOT NULL REFERENCES "server_variants"("id"),
  "enabled" boolean NOT NULL DEFAULT true,
  "selection_weight" integer NOT NULL,
  PRIMARY KEY ("group_id", "variant_id"),
  CONSTRAINT "server_group_variants_weight_check" CHECK ("selection_weight" > 0)
);
CREATE INDEX "server_group_variants_variant_idx" ON "server_group_variants" ("variant_id");

INSERT INTO "server_group_variants" ("group_id", "variant_id", "enabled", "selection_weight")
SELECT "group_id", "id", "enabled", "selection_weight"
FROM "server_variants";

CREATE TABLE "server_variant_layers" (
  "variant_id" text NOT NULL REFERENCES "server_variants"("id") ON DELETE CASCADE,
  "layer_id" text NOT NULL REFERENCES "template_layers"("id"),
  "ordinal" integer NOT NULL,
  PRIMARY KEY ("variant_id", "ordinal"),
  CONSTRAINT "server_variant_layers_ordinal_check" CHECK ("ordinal" >= 0)
);
CREATE UNIQUE INDEX "server_variant_layers_layer_unique"
  ON "server_variant_layers" ("variant_id", "layer_id");

INSERT INTO "server_variant_layers" ("variant_id", "layer_id", "ordinal")
SELECT "id", "id", 0 FROM "server_variants";

ALTER TABLE "server_variants" DROP CONSTRAINT IF EXISTS "server_variants_group_id_fkey";
ALTER TABLE "server_variants" DROP CONSTRAINT IF EXISTS "server_variants_group_id_server_groups_id_fk";
ALTER TABLE "server_variants" DROP CONSTRAINT "server_variants_weight_check";
DROP INDEX "server_variants_group_idx";
ALTER TABLE "server_variants"
  DROP COLUMN "group_id",
  DROP COLUMN "template_path",
  DROP COLUMN "enabled",
  DROP COLUMN "selection_weight";
ALTER TABLE "server_variants"
  ADD CONSTRAINT "server_variants_id_template_layers_id_fk"
  FOREIGN KEY ("id") REFERENCES "template_layers"("id");
