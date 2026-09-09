import type { PriceConfidence, PromotionEvidence } from "../../contracts/src/desktop-collector.ts";
import { derivePromotionDiscounts } from "../../contracts/src/promotion-discount-components.ts";

export interface PublicPriceInput {
  listPriceFen: number;
  activityPriceFen: number;
  promotions: PromotionEvidence[];
  mandatoryFeeFen: number;
  displayedEstimatedPayableFen?: number;
}

export interface PublicPriceResult {
  listPriceFen: number;
  activityPriceFen: number;
  couponDiscountFen: number;
  fullReductionFen: number;
  directDiscountFen: number;
  publicDiscountFen: number;
  mandatoryFeeFen: number;
  payableFen: number | null;
  confidence: PriceConfidence;
  appliedPromotionLabels: string[];
  reviewReasons: string[];
}

function assertFen(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label}必须是非负整数分`);
  }
}

export function calculatePublicPrice(input: PublicPriceInput): PublicPriceResult {
  assertFen(input.listPriceFen, "列表价");
  assertFen(input.activityPriceFen, "活动价");
  assertFen(input.mandatoryFeeFen, "必付费用");
  if (input.displayedEstimatedPayableFen !== undefined) {
    assertFen(input.displayedEstimatedPayableFen, "页面预估到手价");
  }

  for (const promotion of input.promotions) {
    if (promotion.amountFen !== null) {
      assertFen(promotion.amountFen, `优惠“${promotion.label}”`);
    }
    if (promotion.thresholdFen !== null) {
      assertFen(promotion.thresholdFen, `优惠“${promotion.label}”门槛`);
    }
  }

  const {
    appliedPromotionLabels,
    reviewReasons,
    ...components
  } = derivePromotionDiscounts(input.activityPriceFen, input.promotions);
  const baseResult = {
    listPriceFen: input.listPriceFen,
    activityPriceFen: input.activityPriceFen,
    ...components,
    mandatoryFeeFen: input.mandatoryFeeFen,
    appliedPromotionLabels,
    reviewReasons
  };

  if (reviewReasons.length > 0) {
    if (input.displayedEstimatedPayableFen !== undefined) {
      return { ...baseResult, payableFen: input.displayedEstimatedPayableFen, confidence: "ESTIMATED" };
    }
    return { ...baseResult, payableFen: null, confidence: "MANUAL_REVIEW" };
  }

  const payableFen = input.activityPriceFen - components.publicDiscountFen + input.mandatoryFeeFen;
  if (!Number.isSafeInteger(payableFen) || payableFen < 0) {
    return {
      ...baseResult,
      payableFen: null,
      confidence: "MANUAL_REVIEW",
      reviewReasons: ["优惠或费用组合产生无效到手价，需要人工核对"]
    };
  }

  if (input.displayedEstimatedPayableFen !== undefined && input.displayedEstimatedPayableFen !== payableFen) {
    return {
      ...baseResult,
      payableFen: input.displayedEstimatedPayableFen,
      confidence: "ESTIMATED",
      reviewReasons: ["页面预估到手价与可复算到手价不一致，需要人工核对"]
    };
  }

  return { ...baseResult, payableFen, confidence: "CONFIRMED" };
}
