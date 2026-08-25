import assert from "node:assert/strict";
import test from "node:test";

import { calculatePublicPrice } from "./public-price.ts";

test("combines the activity price with deterministic single-unit public discounts", () => {
  const result = calculatePublicPrice({
    listPriceFen: 77_500,
    activityPriceFen: 65_800,
    promotions: [
      { kind: "COUPON", label: "满600减20", amountFen: 2_000, thresholdFen: 60_000, audience: "PUBLIC", stackGroup: "shop-coupon", includedInActivityPrice: false },
      { kind: "FULL_REDUCTION", label: "满650减10", amountFen: 1_000, thresholdFen: 65_000, audience: "PUBLIC", stackGroup: "platform-full", includedInActivityPrice: false }
    ],
    mandatoryFeeFen: 0
  });
  assert.deepEqual(result, {
    listPriceFen: 77_500,
    activityPriceFen: 65_800,
    couponDiscountFen: 2_000,
    fullReductionFen: 1_000,
    directDiscountFen: 0,
    publicDiscountFen: 3_000,
    mandatoryFeeFen: 0,
    payableFen: 62_800,
    confidence: "CONFIRMED",
    appliedPromotionLabels: ["满600减20", "满650减10"],
    reviewReasons: []
  });
});

test("does not apply a public discount when its threshold exceeds the activity price", () => {
  const result = calculatePublicPrice({
    listPriceFen: 77_500,
    activityPriceFen: 65_800,
    promotions: [
      { kind: "FULL_REDUCTION", label: "满700减50", amountFen: 5_000, thresholdFen: 70_000, audience: "PUBLIC", stackGroup: "platform-full", includedInActivityPrice: false }
    ],
    mandatoryFeeFen: 0
  });

  assert.equal(result.publicDiscountFen, 0);
  assert.equal(result.payableFen, 65_800);
  assert.deepEqual(result.appliedPromotionLabels, []);
});

test("uses the largest eligible public discount in each stack group", () => {
  const result = calculatePublicPrice({
    listPriceFen: 80_000,
    activityPriceFen: 70_000,
    promotions: [
      { kind: "COUPON", label: "满600减10", amountFen: 1_000, thresholdFen: 60_000, audience: "PUBLIC", stackGroup: "shop-coupon", includedInActivityPrice: false },
      { kind: "COUPON", label: "满600减20", amountFen: 2_000, thresholdFen: 60_000, audience: "PUBLIC", stackGroup: "shop-coupon", includedInActivityPrice: false },
      { kind: "DIRECT_DISCOUNT", label: "平台立减5", amountFen: 500, thresholdFen: 0, audience: "PUBLIC", stackGroup: "platform-direct", includedInActivityPrice: false }
    ],
    mandatoryFeeFen: 0
  });

  assert.equal(result.couponDiscountFen, 2_000);
  assert.equal(result.directDiscountFen, 500);
  assert.equal(result.publicDiscountFen, 2_500);
  assert.deepEqual(result.appliedPromotionLabels, ["满600减20", "平台立减5"]);
});

test("does not subtract a public promotion already included in the activity price", () => {
  const result = calculatePublicPrice({
    listPriceFen: 70_000,
    activityPriceFen: 60_000,
    promotions: [
      { kind: "DIRECT_DISCOUNT", label: "活动立减100", amountFen: 10_000, thresholdFen: 0, audience: "PUBLIC", stackGroup: "activity-direct", includedInActivityPrice: true }
    ],
    mandatoryFeeFen: 0
  });

  assert.equal(result.directDiscountFen, 0);
  assert.equal(result.payableFen, 60_000);
  assert.deepEqual(result.appliedPromotionLabels, []);
});

test("ignores member-only and 88VIP promotions without lowering confidence", () => {
  const result = calculatePublicPrice({
    listPriceFen: 70_000,
    activityPriceFen: 60_000,
    promotions: [
      { kind: "COUPON", label: "会员券满500减50", amountFen: null, thresholdFen: null, audience: "MEMBER", stackGroup: null, includedInActivityPrice: false },
      { kind: "COUPON", label: "88VIP券满500减50", amountFen: null, thresholdFen: null, audience: "88VIP", stackGroup: null, includedInActivityPrice: false }
    ],
    mandatoryFeeFen: 0
  });

  assert.equal(result.payableFen, 60_000);
  assert.equal(result.confidence, "CONFIRMED");
  assert.deepEqual(result.reviewReasons, []);
});

test("returns manual review when a relevant public promotion is incomplete", () => {
  const result = calculatePublicPrice({
    listPriceFen: 70_000,
    activityPriceFen: 60_000,
    promotions: [
      { kind: "COUPON", label: "公开券详情待确认", amountFen: null, thresholdFen: 50_000, audience: "PUBLIC", stackGroup: "shop-coupon", includedInActivityPrice: false }
    ],
    mandatoryFeeFen: 0
  });

  assert.equal(result.payableFen, null);
  assert.equal(result.confidence, "MANUAL_REVIEW");
  assert.deepEqual(result.reviewReasons, ["公开券详情待确认"]);
});

test("returns manual review when a public promotion lacks any required deterministic field", () => {
  const incompletePromotions = [
    { kind: "COUPON", label: "金额待确认", amountFen: null, thresholdFen: 50_000, audience: "PUBLIC", stackGroup: "shop-coupon", includedInActivityPrice: false },
    { kind: "COUPON", label: "门槛待确认", amountFen: 1_000, thresholdFen: null, audience: "PUBLIC", stackGroup: "shop-coupon", includedInActivityPrice: false },
    { kind: "COUPON", label: "叠加规则待确认", amountFen: 1_000, thresholdFen: 50_000, audience: "PUBLIC", stackGroup: null, includedInActivityPrice: false }
  ];

  for (const promotion of incompletePromotions) {
    const result = calculatePublicPrice({
      listPriceFen: 70_000,
      activityPriceFen: 60_000,
      promotions: [promotion],
      mandatoryFeeFen: 0
    });

    assert.equal(result.payableFen, null);
    assert.equal(result.confidence, "MANUAL_REVIEW");
    assert.deepEqual(result.reviewReasons, [promotion.label]);
  }
});

test("ignores an incomplete public promotion whose known threshold is ineligible", () => {
  const result = calculatePublicPrice({
    listPriceFen: 77_500,
    activityPriceFen: 65_800,
    promotions: [
      { kind: "COUPON", label: "满700减额外优惠", amountFen: null, thresholdFen: 70_000, audience: "PUBLIC", stackGroup: null, includedInActivityPrice: false }
    ],
    mandatoryFeeFen: 0
  });

  assert.equal(result.payableFen, 65_800);
  assert.equal(result.confidence, "CONFIRMED");
  assert.deepEqual(result.reviewReasons, []);
});

test("uses an official displayed estimated payable price when public promotion details are incomplete", () => {
  const result = calculatePublicPrice({
    listPriceFen: 70_000,
    activityPriceFen: 60_000,
    promotions: [
      { kind: "COUPON", label: "公开券详情待确认", amountFen: 1_000, thresholdFen: null, audience: "PUBLIC", stackGroup: "shop-coupon", includedInActivityPrice: false }
    ],
    mandatoryFeeFen: 0,
    displayedEstimatedPayableFen: 59_000
  });

  assert.equal(result.payableFen, 59_000);
  assert.equal(result.confidence, "ESTIMATED");
  assert.deepEqual(result.reviewReasons, ["公开券详情待确认"]);
});

test("adds mandatory fees to the payable price", () => {
  const result = calculatePublicPrice({
    listPriceFen: 70_000,
    activityPriceFen: 60_000,
    promotions: [
      { kind: "COUPON", label: "满500减10", amountFen: 1_000, thresholdFen: 50_000, audience: "PUBLIC", stackGroup: "shop-coupon", includedInActivityPrice: false }
    ],
    mandatoryFeeFen: 600
  });

  assert.equal(result.mandatoryFeeFen, 600);
  assert.equal(result.payableFen, 59_600);
});

test("returns manual review when discounts would make the payable price negative", () => {
  const result = calculatePublicPrice({
    listPriceFen: 1_000,
    activityPriceFen: 1_000,
    promotions: [
      { kind: "DIRECT_DISCOUNT", label: "立减20", amountFen: 2_000, thresholdFen: 0, audience: "PUBLIC", stackGroup: "platform-direct", includedInActivityPrice: false }
    ],
    mandatoryFeeFen: 0
  });

  assert.equal(result.payableFen, null);
  assert.equal(result.confidence, "MANUAL_REVIEW");
  assert.ok(result.reviewReasons.some((reason) => reason.includes("无效到手价")));
});

test("rejects negative and unsafe fen values", () => {
  assert.throws(() => calculatePublicPrice({
    listPriceFen: -1,
    activityPriceFen: 0,
    promotions: [],
    mandatoryFeeFen: 0
  }), /非负整数分/);
  assert.throws(() => calculatePublicPrice({
    listPriceFen: 0,
    activityPriceFen: 0,
    promotions: [],
    mandatoryFeeFen: Number.MAX_SAFE_INTEGER + 1
  }), /非负整数分/);
});

test("rejects aggregate public discounts that overflow despite each input being safe", () => {
  assert.throws(() => calculatePublicPrice({
    listPriceFen: Number.MAX_SAFE_INTEGER,
    activityPriceFen: Number.MAX_SAFE_INTEGER,
    promotions: [
      { kind: "COUPON", label: "大额店铺券", amountFen: Number.MAX_SAFE_INTEGER, thresholdFen: 0, audience: "PUBLIC", stackGroup: "shop-coupon", includedInActivityPrice: false },
      { kind: "DIRECT_DISCOUNT", label: "大额平台立减", amountFen: Number.MAX_SAFE_INTEGER, thresholdFen: 0, audience: "PUBLIC", stackGroup: "platform-direct", includedInActivityPrice: false }
    ],
    mandatoryFeeFen: 0
  }), /金额超出安全范围/);
});

test("validates fen values in ignored private promotions", () => {
  assert.throws(() => calculatePublicPrice({
    listPriceFen: 70_000,
    activityPriceFen: 60_000,
    promotions: [
      { kind: "COUPON", label: "会员券", amountFen: -1, thresholdFen: 50_000, audience: "MEMBER", stackGroup: "member-coupon", includedInActivityPrice: false }
    ],
    mandatoryFeeFen: 0
  }), /非负整数分/);
});
