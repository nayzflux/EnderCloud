CREATE TABLE "server_tps_metrics" (
  "group_id" text NOT NULL,
  "variant_id" text NOT NULL,
  "bucket_at" timestamptz NOT NULL,
  "one_minute_sum" double precision NOT NULL,
  "five_minutes_sum" double precision NOT NULL,
  "fifteen_minutes_sum" double precision NOT NULL,
  "sample_count" integer NOT NULL,
  PRIMARY KEY ("group_id", "variant_id", "bucket_at"),
  CONSTRAINT "server_tps_metrics_sample_count_check" CHECK ("sample_count" > 0)
);

CREATE INDEX "server_tps_metrics_bucket_idx"
  ON "server_tps_metrics" ("bucket_at");
CREATE INDEX "server_tps_metrics_group_bucket_idx"
  ON "server_tps_metrics" ("group_id", "bucket_at");
CREATE INDEX "server_instances_startup_metrics_idx"
  ON "server_instances" ("group_id", "variant_id", "running_at")
  WHERE "starting_at" IS NOT NULL AND "running_at" IS NOT NULL;
