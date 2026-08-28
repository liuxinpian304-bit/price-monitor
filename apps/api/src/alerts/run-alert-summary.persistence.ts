import { z } from "zod";

import { Prisma } from "../../../../generated/prisma/client.ts";
import type { RunAlertSummary } from "../collection/run-alert.service.ts";

const moneySchema = z.number().int().nonnegative().safe();
const nonNegativeIntegerSchema = z.number().int().nonnegative().safe();
const missingOwnGroupSchema = z.object({
  combinationSignature: z.string().min(1),
  combinationLabel: z.string(),
  missingReason: z.enum(["OWN_COMBINATION_ABSENT", "OWN_OUT_OF_STOCK_ONLY"]),
  earliestRank: z.number().int().positive().safe().nullable(),
  minimumConfirmedPayableFen: moneySchema,
  shopCount: nonNegativeIntegerSchema,
  representativeUrl: z.string()
}).strict();
const summarySchema = z.object({
  runId: z.string().min(1),
  monitoredModelId: z.string().min(1),
  brand: z.string(),
  standardModel: z.string(),
  comparisonType: z.enum(["BARE", "BUNDLE"]),
  owner: z.string(),
  completedAt: z.iso.datetime({ offset: true }),
  checkedItemCount: nonNegativeIntegerSchema,
  positionCount: nonNegativeIntegerSchema.optional(),
  shopCount: nonNegativeIntegerSchema.optional(),
  searchLimit: nonNegativeIntegerSchema,
  skuCount: nonNegativeIntegerSchema,
  issueCount: nonNegativeIntegerSchema,
  reviewCount: nonNegativeIntegerSchema.optional(),
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
    ownSnapshotId: z.string().min(1).optional(),
    ownSkuText: z.string().optional(),
    ownPayableFen: moneySchema.optional(),
    combinationSignature: z.string().min(1).optional(),
    combinationLabel: z.string().optional(),
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
  }).strict()),
  missingOwnGroups: z.array(missingOwnGroupSchema).optional()
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
  const baseline = parsed.data.baseline;
  if (parsed.data.alerts.some((alert) => (
    alert.ownSnapshotId === undefined
    || alert.ownSkuText === undefined
    || alert.ownPayableFen === undefined
  ) && baseline === null)) {
    throw new RunAlertNotificationPersistenceError();
  }
  return {
    ...parsed.data,
    completedAt: new Date(parsed.data.completedAt),
    positionCount: parsed.data.positionCount ?? parsed.data.checkedItemCount,
    shopCount: parsed.data.shopCount
      ?? new Set(parsed.data.alerts.map((alert) => alert.shopName)).size,
    reviewCount: parsed.data.reviewCount
      ?? parsed.data.alerts.filter((alert) => alert.severity === "MANUAL_REVIEW").length,
    alerts: parsed.data.alerts.map((alert) => ({
      ...alert,
      ownSnapshotId: alert.ownSnapshotId ?? baseline!.snapshotId,
      ownSkuText: alert.ownSkuText ?? baseline!.skuText,
      ownPayableFen: alert.ownPayableFen ?? baseline!.payableFen,
      combinationSignature: alert.combinationSignature ?? `legacy-price-v2:${alert.alertId}`,
      combinationLabel: alert.combinationLabel ?? alert.skuText
    })),
    missingOwnGroups: parsed.data.missingOwnGroups ?? []
  };
}
