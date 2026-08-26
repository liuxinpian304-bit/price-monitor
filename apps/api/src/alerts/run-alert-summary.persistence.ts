import { z } from "zod";

import { Prisma } from "../../../../generated/prisma/client.ts";
import type { RunAlertSummary } from "../collection/run-alert.service.ts";

const moneySchema = z.number().int().nonnegative().safe();
const nonNegativeIntegerSchema = z.number().int().nonnegative().safe();
const summarySchema = z.object({
  runId: z.string().min(1),
  monitoredModelId: z.string().min(1),
  brand: z.string(),
  standardModel: z.string(),
  comparisonType: z.enum(["BARE", "BUNDLE"]),
  owner: z.string(),
  completedAt: z.iso.datetime({ offset: true }),
  checkedItemCount: nonNegativeIntegerSchema,
  searchLimit: nonNegativeIntegerSchema,
  skuCount: nonNegativeIntegerSchema,
  issueCount: nonNegativeIntegerSchema,
  reportUrl: z.string().max(2_048),
  baseline: z.object({
    snapshotId: z.string().min(1),
    skuId: z.string().min(1),
    skuText: z.string(),
    activityPriceFen: moneySchema,
    publicDiscountFen: moneySchema,
    payableFen: moneySchema
  }).strict().nullable(),
  systemIssue: z.enum(["OWN_BASELINE_MISSING", "OWN_BASELINE_AMBIGUOUS"]).nullable(),
  alerts: z.array(z.object({
    alertId: z.string().min(1),
    severity: z.enum(["CONFIRMED_LOW", "MANUAL_REVIEW"]),
    snapshotId: z.string().min(1),
    rank: z.number().int().positive().safe().nullable(),
    shopName: z.string(),
    title: z.string(),
    skuText: z.string(),
    activityPriceFen: moneySchema,
    publicDiscountFen: moneySchema,
    payableFen: moneySchema,
    differenceFen: moneySchema,
    url: z.string(),
    reasons: z.array(z.string())
  }).strict())
}).strict();

export class RunAlertNotificationPersistenceError extends Error {
  constructor() {
    super("Run alert notification persistence failed");
    this.name = "RunAlertNotificationPersistenceError";
  }
}

export function runAlertSummaryToJson(summary: RunAlertSummary): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(summary)) as Prisma.InputJsonValue;
}

export function runAlertSummaryFromJson(value: Prisma.JsonValue): RunAlertSummary {
  const parsed = summarySchema.safeParse(value);
  if (!parsed.success) throw new RunAlertNotificationPersistenceError();
  return {
    ...parsed.data,
    completedAt: new Date(parsed.data.completedAt)
  };
}
