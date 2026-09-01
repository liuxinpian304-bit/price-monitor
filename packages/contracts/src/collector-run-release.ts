import { z } from "zod";

export const collectorRunReleaseInputSchema = z.discriminatedUnion("disposition", [
  z.object({ disposition: z.literal("REQUEUE") }).strict(),
  z.object({
    disposition: z.literal("QUARANTINE"),
    errorCode: z.literal("INVALID_CHECKPOINT")
  }).strict()
]);

export type CollectorRunReleaseInput = z.infer<typeof collectorRunReleaseInputSchema>;
