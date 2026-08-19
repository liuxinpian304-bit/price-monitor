import assert from "node:assert/strict";
import test from "node:test";

import { bundleReferencePriceFen, bundleSignature } from "./bundle-signature.ts";
import { PriceEngineService } from "./price-engine.service.ts";

test("calculates exact payable price from page price, public discounts and mandatory fees", () => {
  const result = new PriceEngineService().calculate({
    pagePriceFen: 649_900,
    publicDiscounts: [
      { label: "店铺公开券", amountFen: 20_000 },
      { label: "跨店满减", amountFen: 10_000 }
    ],
    mandatoryFees: [{ label: "必付运费", amountFen: 1_200 }],
    privatePriceRequired: false
  });

  assert.deepEqual(result, {
    payableFen: 621_100,
    publicDiscountFen: 30_000,
    confidence: "CONFIRMED",
    reasons: [
      "具体SKU页面价 649900 分",
      "扣除公开优惠 30000 分",
      "加上必付费用 1200 分"
    ]
  });
});

test("returns manual with no payable price when a private chat price is required", () => {
  const result = new PriceEngineService().calculate({
    pagePriceFen: 649_900,
    publicDiscounts: [],
    mandatoryFees: [],
    privatePriceRequired: true
  });

  assert.equal(result.payableFen, null);
  assert.equal(result.confidence, "MANUAL");
  assert.ok(result.reasons.some((reason) => reason.includes("私聊") || reason.includes("客服")));
});

test("returns manual when page price or a public discount amount is uncertain", () => {
  const engine = new PriceEngineService();

  assert.equal(engine.calculate({
    pagePriceFen: null,
    publicDiscounts: [],
    mandatoryFees: [],
    privatePriceRequired: false
  }).payableFen, null);
  assert.equal(engine.calculate({
    pagePriceFen: 649_900,
    publicDiscounts: [{ label: "会员券", amountFen: null }],
    mandatoryFees: [],
    privatePriceRequired: false
  }).confidence, "MANUAL");
});

test("uses integer fen and rejects invalid negative money", () => {
  const engine = new PriceEngineService();

  assert.throws(() => engine.calculate({
    pagePriceFen: -1,
    publicDiscounts: [],
    mandatoryFees: [],
    privatePriceRequired: false
  }), /非负整数/);
});

test("creates the same signature for the same core bundle regardless of row order", () => {
  const items = [
    { accessoryType: "麦克风", brand: "Sennheiser", modelOrName: "MK4", quantity: 1, unitValueFen: 180_000, core: true },
    { accessoryType: "音频线", brand: "STAU", modelOrName: "双卡农线", quantity: 1, unitValueFen: 3_000, core: false }
  ];

  assert.equal(bundleSignature(items), bundleSignature([...items].reverse()));
  assert.equal(
    bundleSignature(items),
    bundleSignature([{ ...items[0]!, accessoryType: " 麦克风 ", brand: "SENNHEISER", modelOrName: "mk4" }])
  );
});

test("different core configurations never share a signature", () => {
  const mk4 = [{ accessoryType: "麦克风", brand: "Sennheiser", modelOrName: "MK4", quantity: 1, unitValueFen: 180_000, core: true }];
  const mk8 = [{ ...mk4[0]!, modelOrName: "MK8" }];

  assert.notEqual(bundleSignature(mk4), bundleSignature(mk8));
});

test("subtracts accessory reference values without floating point math", () => {
  const items = [
    { accessoryType: "麦克风", brand: "Sennheiser", modelOrName: "MK4", quantity: 1, unitValueFen: 180_000, core: true },
    { accessoryType: "音频线", brand: "STAU", modelOrName: "双卡农线", quantity: 2, unitValueFen: 3_000, core: false }
  ];

  assert.equal(bundleReferencePriceFen(799_900, items), 613_900);
});
