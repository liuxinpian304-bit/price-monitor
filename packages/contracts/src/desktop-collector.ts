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
const POSTGRES_INT_MAX = 2_147_483_647;
const moneyFenSchema = z.number().int().nonnegative().max(POSTGRES_INT_MAX);
const positiveCountSchema = z.number().int().positive().max(POSTGRES_INT_MAX);
const nonNegativeCountSchema = z.number().int().nonnegative().max(POSTGRES_INT_MAX);
const searchLimitSchema = positiveCountSchema.max(50);
const identifierSchema = z.string().min(1);
const reportIdentifierSchema = identifierSchema.max(160);
const urlSchema = z.url();
const reportUrlSchema = urlSchema.max(2_048);
const evidenceKeySchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const attributesSchema = z.record(z.string().min(1).max(200), z.string().max(1_000));

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
  searchLimit: searchLimitSchema,
  ownShopName: z.string().min(1),
  ownListings: z.array(ownListingSchema),
  rule: ruleSchema
}).strict();

const promotionEvidenceSchema = z.object({
  kind: z.string().min(1).max(120),
  label: z.string().min(1).max(500),
  amountFen: moneyFenSchema.nullable(),
  thresholdFen: moneyFenSchema.nullable(),
  audience: z.string().min(1).max(120),
  stackGroup: z.string().min(1).max(120).nullable(),
  includedInActivityPrice: z.boolean()
}).strict();

const collectedSkuSchema = z.object({
  skuId: reportIdentifierSchema,
  label: z.string().min(1).max(500),
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
  payableFen: moneyFenSchema.nullable(),
  capturedAt: timestampSchema,
  evidenceKey: evidenceKeySchema.nullable()
}).strict();

const collectedItemBaseSchema = {
  platformItemId: reportIdentifierSchema,
  url: reportUrlSchema,
  shopName: z.string().min(1).max(200),
  title: z.string().min(1).max(1_000),
  searchRanks: z.array(positiveCountSchema),
  skus: z.array(collectedSkuSchema)
};

const ownItemSchema = z.object({
  ...collectedItemBaseSchema,
  ownListingId: reportIdentifierSchema
}).strict();

const competitorItemSchema = z.object(collectedItemBaseSchema).strict();

const searchPositionSchema = z.object({
  rank: positiveCountSchema,
  platformItemId: reportIdentifierSchema,
  url: reportUrlSchema,
  shopName: z.string().min(1).max(200),
  title: z.string().min(1).max(1_000),
  displayPriceMinFen: moneyFenSchema,
  displayPriceMaxFen: moneyFenSchema,
  sponsored: z.boolean(),
  capturedAt: timestampSchema
}).strict();

const collectorIssueSchema = z.object({
  code: issueCodeSchema,
  message: z.string().min(1).max(4_000),
  platformItemId: reportIdentifierSchema.nullable().optional(),
  skuId: reportIdentifierSchema.nullable().optional(),
  evidenceKey: evidenceKeySchema.nullable().optional(),
  capturedAt: timestampSchema
}).strict();

const reportBodySchema = z.object({
  schemaVersion: schemaVersionSchema,
  runId: reportIdentifierSchema,
  collectorId: reportIdentifierSchema,
  appVersion: z.string().min(1).max(120),
  startedAt: timestampSchema,
  completedAt: timestampSchema,
  status: reportStatusSchema,
  searchLimit: searchLimitSchema,
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

  for (const [positionIndex, position] of report.positions.entries()) {
    if (position.displayPriceMinFen > position.displayPriceMaxFen) {
      context.addIssue({
        code: "custom",
        path: ["positions", positionIndex, "displayPriceMinFen"],
        message: "displayPriceMinFen must not exceed displayPriceMaxFen"
      });
    }
  }

  const positionsByRank = new Map(report.positions.map((position) => [position.rank, position.platformItemId]));
  const itemIssueCodes = new Set([
    "SKU_ENUMERATION_INCOMPLETE",
    "SKU_SELECTION_MISMATCH",
    "PRICE_UNSTABLE"
  ]);
  const emptyItemIssueCodes = new Set(["ITEM_UNAVAILABLE", "SKU_ENUMERATION_INCOMPLETE"]);

  for (const [issueIndex, issue] of report.issues.entries()) {
    if (itemIssueCodes.has(issue.code) && !issue.platformItemId) {
      context.addIssue({
        code: "custom",
        path: ["issues", issueIndex, "platformItemId"],
        message: `${issue.code} must identify a platformItemId`
      });
    }
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

    for (const [rankIndex, rank] of item.searchRanks.entries()) {
      if (positionsByRank.get(rank) !== item.platformItemId) {
        context.addIssue({
          code: "custom",
          path: [itemCollection, itemIndex, "searchRanks", rankIndex],
          message: "searchRanks must reference positions for the same platformItemId"
        });
      }
    }

    if (item.skus.length === 0 && !report.issues.some((issue) =>
      issue.platformItemId === item.platformItemId && emptyItemIssueCodes.has(issue.code)
    )) {
      context.addIssue({
        code: "custom",
        path: [itemCollection, itemIndex, "skus"],
        message: "an item without SKUs requires a matching availability or enumeration issue"
      });
    }

    for (const [skuIndex, sku] of item.skus.entries()) {
      const skuKey = `${item.platformItemId}:${sku.skuId}`;
      if (skuKeys.has(skuKey)) {
        context.addIssue({
          code: "custom",
          path: [itemCollection, itemIndex, "skus"],
          message: "SKU identities must be unique per item"
        });
      }
      skuKeys.add(skuKey);

      if (sku.priceConfidence === "ESTIMATED" && sku.payableFen === null) {
        context.addIssue({
          code: "custom",
          path: [itemCollection, itemIndex, "skus", skuIndex, "payableFen"],
          message: "ESTIMATED prices require payableFen"
        });
      }

      if (sku.priceConfidence === "CONFIRMED") {
        const expectedPayableFen = sku.activityPriceFen - sku.couponDiscountFen
          - sku.fullReductionFen - sku.directDiscountFen + sku.mandatoryFeeFen;
        if (!Number.isSafeInteger(expectedPayableFen) || expectedPayableFen < 0
          || sku.payableFen === null || sku.payableFen !== expectedPayableFen) {
          context.addIssue({
            code: "custom",
            path: [itemCollection, itemIndex, "skus", skuIndex, "payableFen"],
            message: "CONFIRMED payableFen must equal the non-negative component formula"
          });
        }
      }

      const publicDiscountFen = sku.couponDiscountFen
        + sku.fullReductionFen + sku.directDiscountFen;
      if (publicDiscountFen > POSTGRES_INT_MAX) {
        context.addIssue({
          code: "custom",
          path: [itemCollection, itemIndex, "skus", skuIndex, "couponDiscountFen"],
          message: "combined public discounts must fit a PostgreSQL Int"
        });
      }
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
