import { z } from "zod";

export const PRICE_CONFIDENCES = ["CONFIRMED", "ESTIMATED", "MANUAL_REVIEW"] as const;
export const COLLECTOR_REPORT_STATUSES = [
  "SUCCEEDED", "PARTIAL_FAILED", "PAUSED_LOGIN", "PAUSED_CHALLENGE", "FAILED"
] as const;
export const COLLECTOR_ISSUE_CODES = [
  "MISSING_ITEM_ID", "ITEM_UNAVAILABLE", "SKU_ENUMERATION_INCOMPLETE",
  "SKU_SELECTION_MISMATCH", "PRICE_UNSTABLE", "LOGIN_REQUIRED",
  "PLATFORM_CHALLENGE", "APP_VERSION_UNSUPPORTED", "UI_CONTRACT_CHANGED",
  "SCREEN_RECORDING_PERMISSION_REQUIRED", "OWN_BASELINE_MISSING",
  "OWN_BASELINE_AMBIGUOUS"
] as const;

const schemaVersionSchema = z.literal(1);
const timestampSchema = z.iso.datetime({ offset: true });
const moneyFenSchema = z.number().int().nonnegative().safe();
const positiveCountSchema = z.number().int().positive().safe();
const nonNegativeCountSchema = z.number().int().nonnegative().safe();
const identifierSchema = z.string().min(1);
const urlSchema = z.url();
const evidenceKeySchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const attributesSchema = z.record(z.string(), z.string());

const comparisonTypeSchema = z.enum(["BARE", "BUNDLE"]);
const stockStateSchema = z.enum(["IN_STOCK", "OUT_OF_STOCK", "UNKNOWN"]);
const priceConfidenceSchema = z.enum(PRICE_CONFIDENCES);
const reportStatusSchema = z.enum(COLLECTOR_REPORT_STATUSES);
const issueCodeSchema = z.enum(COLLECTOR_ISSUE_CODES);

const ownListingSchema = z.object({
  id: identifierSchema,
  url: urlSchema,
  skuText: z.string().min(1)
}).strict();

const ruleSchema = z.object({
  brand: z.string().min(1),
  standardModel: z.string().min(1),
  version: z.string().min(1).nullable(),
  comparisonType: comparisonTypeSchema,
  effectiveAliases: z.array(z.string().min(1)),
  excludedAliases: z.array(z.string().min(1)),
  mustIncludeTerms: z.array(z.string().min(1)),
  excludedTerms: z.array(z.string().min(1))
}).strict();

export const collectorJobSchema = z.object({
  schemaVersion: schemaVersionSchema,
  runId: identifierSchema,
  collectorId: identifierSchema,
  monitoredModelId: identifierSchema,
  searchQuery: z.string().min(1),
  searchLimit: positiveCountSchema,
  ownShopName: z.string().min(1),
  ownListings: z.array(ownListingSchema),
  rule: ruleSchema
}).strict();

const promotionEvidenceSchema = z.object({
  kind: z.string().min(1),
  label: z.string().min(1),
  amountFen: moneyFenSchema,
  thresholdFen: moneyFenSchema,
  audience: z.string().min(1),
  stackGroup: z.string().min(1),
  includedInActivityPrice: z.boolean()
}).strict();

const collectedSkuSchema = z.object({
  skuId: identifierSchema,
  label: z.string().min(1),
  attributes: attributesSchema,
  stockState: stockStateSchema,
  listPriceFen: moneyFenSchema,
  activityPriceFen: moneyFenSchema,
  couponDiscountFen: moneyFenSchema,
  fullReductionFen: moneyFenSchema,
  directDiscountFen: moneyFenSchema,
  promotions: z.array(promotionEvidenceSchema),
  mandatoryFeeFen: moneyFenSchema,
  priceConfidence: priceConfidenceSchema,
  payableFen: moneyFenSchema,
  capturedAt: timestampSchema,
  evidenceKey: evidenceKeySchema.nullable()
}).strict();

const collectedItemBaseSchema = {
  platformItemId: identifierSchema,
  url: urlSchema,
  shopName: z.string().min(1),
  title: z.string().min(1),
  searchRanks: z.array(positiveCountSchema),
  skus: z.array(collectedSkuSchema)
};

const ownItemSchema = z.object({
  ...collectedItemBaseSchema,
  ownListingId: identifierSchema
}).strict();

const competitorItemSchema = z.object(collectedItemBaseSchema).strict();

const searchPositionSchema = z.object({
  rank: positiveCountSchema,
  platformItemId: identifierSchema,
  url: urlSchema,
  shopName: z.string().min(1),
  title: z.string().min(1),
  displayPriceMinFen: moneyFenSchema,
  displayPriceMaxFen: moneyFenSchema,
  sponsored: z.boolean(),
  capturedAt: timestampSchema
}).strict();

const collectorIssueSchema = z.object({
  code: issueCodeSchema,
  message: z.string().min(1),
  platformItemId: identifierSchema.nullable().optional(),
  skuId: identifierSchema.nullable().optional(),
  evidenceKey: evidenceKeySchema.nullable().optional(),
  capturedAt: timestampSchema
}).strict();

const reportBodySchema = z.object({
  schemaVersion: schemaVersionSchema,
  runId: identifierSchema,
  collectorId: identifierSchema,
  appVersion: identifierSchema,
  startedAt: timestampSchema,
  completedAt: timestampSchema,
  status: reportStatusSchema,
  searchLimit: positiveCountSchema,
  positions: z.array(searchPositionSchema),
  ownItems: z.array(ownItemSchema),
  competitorItems: z.array(competitorItemSchema),
  issues: z.array(collectorIssueSchema)
}).strict();

export const collectorReportSchema = reportBodySchema.superRefine((report, context) => {
  if (Date.parse(report.completedAt) < Date.parse(report.startedAt)) {
    context.addIssue({
      code: "custom",
      path: ["completedAt"],
      message: "completedAt must not precede startedAt"
    });
  }

  if (report.positions.length > report.searchLimit) {
    context.addIssue({
      code: "custom",
      path: ["positions"],
      message: "positions cannot exceed searchLimit"
    });
  }

  const ranks = report.positions.map((position) => position.rank);
  const uniqueRanks = new Set(ranks);
  if (uniqueRanks.size !== ranks.length || ranks.some((rank, index) => rank !== index + 1)) {
    context.addIssue({
      code: "custom",
      path: ["positions"],
      message: "positions must have unique contiguous ranks starting at 1"
    });
  }

  const items = [...report.ownItems, ...report.competitorItems];
  const itemIds = new Set<string>();
  const ownListingIds = new Set<string>();
  const skuKeys = new Set<string>();

  for (const [index, item] of items.entries()) {
    const itemCollection = index < report.ownItems.length ? "ownItems" : "competitorItems";
    const itemIndex = index < report.ownItems.length ? index : index - report.ownItems.length;
    if (itemIds.has(item.platformItemId)) {
      context.addIssue({
        code: "custom",
        path: [itemCollection, itemIndex],
        message: "item identities must be unique"
      });
    }
    itemIds.add(item.platformItemId);

    if ("ownListingId" in item && typeof item.ownListingId === "string") {
      if (ownListingIds.has(item.ownListingId)) {
        context.addIssue({
          code: "custom",
          path: [itemCollection, itemIndex],
          message: "own listing identities must be unique"
        });
      }
      ownListingIds.add(item.ownListingId);
    }

    const itemRanks = new Set(item.searchRanks);
    if (itemRanks.size !== item.searchRanks.length) {
      context.addIssue({
        code: "custom",
        path: [itemCollection, itemIndex, "searchRanks"],
        message: "search ranks must be unique per item"
      });
    }

    for (const sku of item.skus) {
      const skuKey = `${item.platformItemId}:${sku.skuId}`;
      if (skuKeys.has(skuKey)) {
        context.addIssue({
          code: "custom",
          path: [itemCollection, itemIndex, "skus"],
          message: "SKU identities must be unique per item"
        });
      }
      skuKeys.add(skuKey);
    }
  }
});

export const collectorHeartbeatSchema = z.object({
  schemaVersion: schemaVersionSchema,
  runId: identifierSchema,
  collectorId: identifierSchema,
  observedAt: timestampSchema,
  discoveredCount: nonNegativeCountSchema,
  skuCount: nonNegativeCountSchema
}).strict();

export type PriceConfidence = z.infer<typeof priceConfidenceSchema>;
export type PromotionEvidence = z.infer<typeof promotionEvidenceSchema>;
export type CollectorJob = z.infer<typeof collectorJobSchema>;
export type CollectedSku = z.infer<typeof collectedSkuSchema>;
export type CollectedItem = z.infer<typeof ownItemSchema> | z.infer<typeof competitorItemSchema>;
export type CollectorIssue = z.infer<typeof collectorIssueSchema>;
export type CollectorReport = z.infer<typeof collectorReportSchema>;
export type CollectorHeartbeat = z.infer<typeof collectorHeartbeatSchema>;
