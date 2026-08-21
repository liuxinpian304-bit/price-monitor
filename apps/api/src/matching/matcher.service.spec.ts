import assert from "node:assert/strict";
import test from "node:test";

import type { RawOffer } from "../collection/providers/commerce-provider.ts";
import { MatcherService } from "./matcher.service.ts";
import type { MonitoredProductRule } from "./matcher.types.ts";

const rule: MonitoredProductRule = {
  brand: "RME",
  standardModel: "Babyface Pro FS",
  version: "FS新版",
  comparisonType: "BARE",
  effectiveAliases: ["娃娃脸FS", "Babyface Pro FS"],
  excludedAliases: ["Babyface Pro旧款"],
  mustIncludeTerms: ["Babyface", "FS"],
  excludedTerms: ["二手", "租赁", "定金", "维修", "旧款"]
};

function offer(title: string, skuLabel = "Babyface Pro FS 单机"): RawOffer {
  return {
    platformItemId: "1001",
    url: "https://detail.tmall.com/item.htm?id=1001",
    shopName: "同行专业音频店",
    title,
    selectedSkuId: "sku-1",
    skuOptions: [{
      skuId: "sku-1",
      label: skuLabel,
      attributes: { 版本: "FS新版" },
      listPriceFen: 649_900,
      publicDiscountFen: 20000,
      payableFen: 629_900,
      stockState: "IN_STOCK"
    }],
    listPriceFen: 649_900,
    publicDiscountFen: 20000,
    payableFen: 629_900,
    promotions: [],
    gifts: [],
    stockState: "IN_STOCK",
    capturedAt: new Date("2026-08-19T01:30:00.000Z"),
    evidenceUrl: null,
    rawEvidence: {}
  };
}

test("accepts an exact Babyface Pro FS bare SKU with explainable reasons", () => {
  const decision = new MatcherService().match(
    rule,
    offer("RME Babyface Pro FS 专业声卡 官方标配")
  );

  assert.equal(decision.category, "BARE");
  assert.equal(decision.comparable, true);
  assert.equal(decision.normalizedModel, "Babyface Pro FS");
  assert.ok(decision.confidence >= 0.9);
  assert.ok(decision.reasons.some((reason) => reason.includes("标准型号")));
});

test("rejects the older Babyface Pro model when FS is absent", () => {
  const decision = new MatcherService().match(
    rule,
    offer("RME Babyface Pro USB 老版本声卡", "Babyface Pro 单机")
  );

  assert.equal(decision.category, "REJECTED");
  assert.equal(decision.comparable, false);
  assert.ok(decision.reasons.some((reason) => reason.includes("FS") || reason.includes("型号")));
});

test("classifies an exact bundle separately from a bare listing", () => {
  const matcher = new MatcherService();
  const bundleOffer = offer(
    "RME Babyface Pro FS MK4录音套装",
    "Babyface Pro FS+MK4套装"
  );

  const forBundle = matcher.match({ ...rule, comparisonType: "BUNDLE" }, bundleOffer);
  const forBare = matcher.match(rule, bundleOffer);

  assert.equal(forBundle.category, "BUNDLE");
  assert.equal(forBundle.comparable, true);
  assert.equal(forBare.category, "BUNDLE");
  assert.equal(forBare.comparable, false);
  assert.ok(forBare.reasons.some((reason) => reason.includes("裸机") && reason.includes("套装")));
});

for (const excludedTerm of ["二手", "定金", "维修", "租赁"]) {
  test(`rejects an offer containing excluded term ${excludedTerm}`, () => {
    const decision = new MatcherService().match(
      rule,
      offer(`RME Babyface Pro FS ${excludedTerm}专拍`)
    );

    assert.equal(decision.category, "REJECTED");
    assert.equal(decision.comparable, false);
    assert.ok(decision.reasons.some((reason) => reason.includes(excludedTerm)));
  });
}

test("sends an exact model with no reliable bare-or-bundle signal to manual review", () => {
  const decision = new MatcherService().match(
    rule,
    offer("RME Babyface Pro FS 专业录音声卡", "Babyface Pro FS")
  );

  assert.equal(decision.category, "MANUAL");
  assert.equal(decision.comparable, false);
  assert.ok(decision.reasons.some((reason) => reason.includes("人工")));
});

test("every decision includes a readable reason", () => {
  const matcher = new MatcherService();
  const decisions = [
    matcher.match(rule, offer("RME Babyface Pro FS 官方标配")),
    matcher.match(rule, offer("RME Babyface Pro 旧款")),
    matcher.match(rule, offer("RME Babyface Pro FS 声卡", "Babyface Pro FS"))
  ];

  assert.ok(decisions.every((decision) => decision.reasons.length > 0));
});
