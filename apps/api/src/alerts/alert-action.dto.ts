import { z } from "zod";

export const alertActionSchema = z.object({
  status: z.enum(["PENDING", "PRICE_CHANGED", "NO_FOLLOW", "FALSE_POSITIVE", "WATCHING"]),
  reasonCode: z.string().trim().min(1).max(120).optional(),
  note: z.string().trim().max(2000).optional()
}).superRefine((action, context) => {
  if (
    (action.status === "NO_FOLLOW" || action.status === "FALSE_POSITIVE") &&
    !action.reasonCode
  ) {
    context.addIssue({
      code: "custom",
      path: ["reasonCode"],
      message: "不跟价和误报必须选择原因"
    });
  }
});

export type AlertActionInput = z.input<typeof alertActionSchema>;
export type ValidatedAlertActionInput = z.output<typeof alertActionSchema>;
