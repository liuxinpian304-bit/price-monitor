import { calculatePublicPrice } from "@stau-price-monitor/config/public-price";
import type { PriceConfidence, PromotionEvidence } from "@stau-price-monitor/contracts";

const POSTGRES_INT_MAX = 2_147_483_647;
const ACTIVITY_PRICE_INCLUSIONS = new Set(["INCLUDED", "EXCLUDED", "UNKNOWN"]);
const PRICE_CONFIDENCES = new Set<PriceConfidence>(["CONFIRMED", "ESTIMATED", "MANUAL_REVIEW"]);

type MigratableSku = Record<string, unknown> & {
  listPriceFen: number;
  activityPriceFen: number;
  couponDiscountFen: number;
  fullReductionFen: number;
  directDiscountFen: number;
  promotions: PromotionEvidence[];
  mandatoryFeeFen: number;
  priceConfidence: PriceConfidence;
  payableFen: number | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMoneyFen(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= POSTGRES_INT_MAX;
}

function isNullableMoneyFen(value: unknown): value is number | null {
  return value === null || isMoneyFen(value);
}

function isBoundedNonEmptyString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function isPromotionEvidence(value: unknown): value is PromotionEvidence {
  return isRecord(value)
    && isBoundedNonEmptyString(value.kind, 120)
    && isBoundedNonEmptyString(value.label, 500)
    && isNullableMoneyFen(value.amountFen)
    && isNullableMoneyFen(value.thresholdFen)
    && isBoundedNonEmptyString(value.audience, 120)
    && (value.stackGroup === null || isBoundedNonEmptyString(value.stackGroup, 120))
    && typeof value.includedInActivityPrice === "boolean"
    && typeof value.activityPriceInclusion === "string"
    && ACTIVITY_PRICE_INCLUSIONS.has(value.activityPriceInclusion);
}

function hasSafePromotionTotal(promotions: PromotionEvidence[]): boolean {
  let total = 0;
  for (const promotion of promotions) {
    if (promotion.audience !== "PUBLIC"
      || promotion.activityPriceInclusion !== "EXCLUDED"
      || promotion.amountFen === null) {
      continue;
    }
    if (total > Number.MAX_SAFE_INTEGER - promotion.amountFen) return false;
    total += promotion.amountFen;
  }
  return true;
}

function isMigratableSku(value: unknown): value is MigratableSku {
  if (!isRecord(value)
    || !isMoneyFen(value.listPriceFen)
    || !isMoneyFen(value.activityPriceFen)
    || !isMoneyFen(value.couponDiscountFen)
    || !isMoneyFen(value.fullReductionFen)
    || !isMoneyFen(value.directDiscountFen)
    || !Array.isArray(value.promotions)
    || !value.promotions.every(isPromotionEvidence)
    || !isMoneyFen(value.mandatoryFeeFen)
    || !PRICE_CONFIDENCES.has(value.priceConfidence as PriceConfidence)
    || !isNullableMoneyFen(value.payableFen)) {
    return false;
  }
  return hasSafePromotionTotal(value.promotions);
}

function normalizePromotion(value: unknown): void {
  if (!isRecord(value) || Object.hasOwn(value, "activityPriceInclusion")) return;
  value.activityPriceInclusion = value.includedInActivityPrice === true ? "INCLUDED" : "UNKNOWN";
}

function migrateItemSkus(value: unknown): void {
  if (!isRecord(value) || !Array.isArray(value.skus)) return;
  for (const sku of value.skus) {
    if (!isRecord(sku) || !Array.isArray(sku.promotions)) continue;
    for (const promotion of sku.promotions) normalizePromotion(promotion);
    if (!isMigratableSku(sku) || !sku.promotions.some((promotion) =>
      promotion.audience === "PUBLIC" && promotion.activityPriceInclusion === "UNKNOWN")) {
      continue;
    }

    const price = calculatePublicPrice({
      listPriceFen: sku.listPriceFen,
      activityPriceFen: sku.activityPriceFen,
      promotions: sku.promotions,
      mandatoryFeeFen: sku.mandatoryFeeFen
    });
    sku.couponDiscountFen = price.couponDiscountFen;
    sku.fullReductionFen = price.fullReductionFen;
    sku.directDiscountFen = price.directDiscountFen;
    sku.payableFen = price.payableFen;
    sku.priceConfidence = price.confidence;
  }
}

export function migrateLegacyCheckpointReport(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const migrated = structuredClone(value);
  for (const collection of ["ownItems", "competitorItems"] as const) {
    const items = migrated[collection];
    if (!Array.isArray(items)) continue;
    for (const item of items) migrateItemSkus(item);
  }
  return migrated;
}
