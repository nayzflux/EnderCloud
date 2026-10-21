import { z } from "zod";
import { instanceCreateSchema, positiveIntegerSchema } from "@endercloud/contracts/schemas";

/** Immutable command snapshot; host and instance identity live on the instance row. */
export const createCommandSchema = instanceCreateSchema.pick({ instanceType: true, runtime: true, templateLayers: true }).extend({
  version: z.literal(1), variantRevision: positiveIntegerSchema, variantChecksum: z.string().min(1),
});
export type CreateCommandPayload = z.infer<typeof createCommandSchema>;
