import type { PriceConfidence, PromotionEvidence } from "../../contracts/src/desktop-collector.ts";

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

interface AppliedPromotion {
  kind: string;
  label: string;
  amountFen: number;
}

type CompletePublicPromotion = PromotionEvidence & {
  amountFen: number;
  thresholdFen: number;
  stackGroup: string;
};

function assertFen(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label}必须是非负整数分`);
  }
}

function addFen(total: number, value: number, label: string): number {
  const next = total + value;
  if (!Number.isSafeInteger(next)) {
    throw new RangeError(`${label}金额超出安全范围`);
  }
  return next;
}

function isPublicPromotion(promotion: PromotionEvidence): boolean {
  return promotion.audience === "PUBLIC";
}

function hasCompletePublicPromotion(promotion: PromotionEvidence): promotion is CompletePublicPromotion {
  return promotion.amountFen !== null && promotion.thresholdFen !== null && promotion.stackGroup !== null;
}

function discountComponents(promotions: AppliedPromotion[]): Pick<PublicPriceResult,
  "couponDiscountFen" | "fullReductionFen" | "directDiscountFen" | "publicDiscountFen"> {
  let couponDiscountFen = 0;
  let fullReductionFen = 0;
  let directDiscountFen = 0;

  for (const promotion of promotions) {
    if (promotion.kind === "COUPON") {
      couponDiscountFen = addFen(couponDiscountFen, promotion.amountFen, "优惠");
    } else if (promotion.kind === "FULL_REDUCTION") {
      fullReductionFen = addFen(fullReductionFen, promotion.amountFen, "优惠");
    } else {
      directDiscountFen = addFen(directDiscountFen, promotion.amountFen, "优惠");
    }
  }

  const publicDiscountFen = addFen(
    addFen(couponDiscountFen, fullReductionFen, "优惠"),
    directDiscountFen,
    "优惠"
  );

  return { couponDiscountFen, fullReductionFen, directDiscountFen, publicDiscountFen };
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

  const selectedByStackGroup = new Map<string, AppliedPromotion>();
  const reviewReasons: string[] = [];

  for (const promotion of input.promotions) {
    if (!isPublicPromotion(promotion)) {
      continue;
    }

    const inclusion = promotion.activityPriceInclusion ?? "UNKNOWN";
    if (inclusion === "INCLUDED") continue;
    if (inclusion !== "EXCLUDED") {
      reviewReasons.push(promotion.label);
      continue;
    }

    if (promotion.thresholdFen !== null && input.activityPriceFen < promotion.thresholdFen) {
      continue;
    }

    if (!hasCompletePublicPromotion(promotion)) {
      reviewReasons.push(promotion.label);
      continue;
    }

    const current = selectedByStackGroup.get(promotion.stackGroup);
    if (current === undefined || promotion.amountFen > current.amountFen) {
      selectedByStackGroup.set(promotion.stackGroup, {
        kind: promotion.kind,
        label: promotion.label,
        amountFen: promotion.amountFen
      });
    }
  }

  const appliedPromotions = [...selectedByStackGroup.values()];
  const components = discountComponents(appliedPromotions);
  const baseResult = {
    listPriceFen: input.listPriceFen,
    activityPriceFen: input.activityPriceFen,
    ...components,
    mandatoryFeeFen: input.mandatoryFeeFen,
    appliedPromotionLabels: appliedPromotions.map((promotion) => promotion.label),
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

  return { ...baseResult, payableFen, confidence: "CONFIRMED" };
}
