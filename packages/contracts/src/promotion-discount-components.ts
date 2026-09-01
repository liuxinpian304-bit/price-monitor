export interface PromotionDiscountEvidence {
  kind: string;
  label: string;
  amountFen: number | null;
  thresholdFen: number | null;
  audience: string;
  stackGroup: string | null;
  activityPriceInclusion?: "INCLUDED" | "EXCLUDED" | "UNKNOWN";
}

export interface PromotionDiscountComponents {
  couponDiscountFen: number;
  fullReductionFen: number;
  directDiscountFen: number;
  publicDiscountFen: number;
}

export interface PromotionDiscountDerivation extends PromotionDiscountComponents {
  appliedPromotionLabels: string[];
  reviewReasons: string[];
}

interface AppliedPromotion {
  kind: string;
  label: string;
  amountFen: number;
}

const KNOWN_PRIVATE_AUDIENCES = new Set([
  "MEMBER",
  "88VIP",
  "ACCOUNT",
  "PERSONAL_RED_PACKET"
]);

function addFen(total: number, value: number): number {
  const next = total + value;
  if (!Number.isSafeInteger(next)) {
    throw new RangeError("优惠金额超出安全范围");
  }
  return next;
}

export function derivePromotionDiscounts(
  activityPriceFen: number,
  promotions: readonly PromotionDiscountEvidence[]
): PromotionDiscountDerivation {
  const selectedByStackGroup = new Map<string, AppliedPromotion>();
  const reviewReasons: string[] = [];

  for (const promotion of promotions) {
    if (promotion.audience !== "PUBLIC") {
      if (!KNOWN_PRIVATE_AUDIENCES.has(promotion.audience)) reviewReasons.push(promotion.label);
      continue;
    }

    if (promotion.activityPriceInclusion === "INCLUDED") continue;
    if (promotion.activityPriceInclusion !== "EXCLUDED") {
      reviewReasons.push(promotion.label);
      continue;
    }

    if (promotion.thresholdFen !== null && activityPriceFen < promotion.thresholdFen) continue;
    if (promotion.amountFen === null || promotion.thresholdFen === null || promotion.stackGroup === null) {
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

  let couponDiscountFen = 0;
  let fullReductionFen = 0;
  let directDiscountFen = 0;
  const appliedPromotions = [...selectedByStackGroup.values()];

  for (const promotion of appliedPromotions) {
    if (promotion.kind === "COUPON") {
      couponDiscountFen = addFen(couponDiscountFen, promotion.amountFen);
    } else if (promotion.kind === "FULL_REDUCTION") {
      fullReductionFen = addFen(fullReductionFen, promotion.amountFen);
    } else {
      directDiscountFen = addFen(directDiscountFen, promotion.amountFen);
    }
  }

  const publicDiscountFen = addFen(addFen(couponDiscountFen, fullReductionFen), directDiscountFen);
  return {
    couponDiscountFen,
    fullReductionFen,
    directDiscountFen,
    publicDiscountFen,
    appliedPromotionLabels: appliedPromotions.map((promotion) => promotion.label),
    reviewReasons
  };
}
