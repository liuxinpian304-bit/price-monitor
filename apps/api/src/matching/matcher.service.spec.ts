import assert from "node:assert/strict";
import test from "node:test";

import type { RawOffer } from "../collection/providers/commerce-provider.ts";
import { MatcherService, normalizeText } from "./matcher.service.ts";
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

test("normalizes Turkish-sensitive I with locale-independent Unicode lowercase", () => {
  assert.equal("I".toLocaleLowerCase("tr"), "ı");
  const original = String.prototype.toLocaleLowerCase;
  String.prototype.toLocaleLowerCase = function (this: string): string {
    return original.call(this, "tr");
  };
  try {
    assert.equal(normalizeText("I-7506"), "i 7506");
  } finally {
    String.prototype.toLocaleLowerCase = original;
  }
});

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

test("accepts configured model tokens across supported punctuation", () => {
  const decision = new MatcherService().match(
    rule,
    offer("RME Babyface-Pro/FS 专业声卡 官方标配", "Babyface-Pro/FS 单机")
  );

  assert.equal(decision.category, "BARE");
  assert.equal(decision.comparable, true);
});

test("rejects a configured model embedded inside a longer alphanumeric token", () => {
  for (const embeddedModel of ["XBabyface Pro FS", "Babyface Pro FSX"]) {
    const decision = new MatcherService().match(
      rule,
      offer(`RME ${embeddedModel} FS新版 官方标配`, `${embeddedModel} 单机`)
    );

    assert.equal(decision.category, "REJECTED", embeddedModel);
    assert.equal(decision.comparable, false, embeddedModel);
  }
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

const sonyRule: MonitoredProductRule = {
  brand: "Sony",
  standardModel: "MDR-7506",
  version: null,
  comparisonType: "BARE",
  effectiveAliases: ["索尼 7506", "7506"],
  excludedAliases: ["M1", "MV1"],
  mustIncludeTerms: [],
  excludedTerms: ["M1", "MV1", "展示样机", "单独转换线"]
};

function sonyOffer(skuLabel: string, attributes: Record<string, string> = {}): RawOffer {
  const result = offer("索尼 7506 专业监听耳机", skuLabel);
  result.skuOptions[0]!.attributes = attributes;
  return result;
}

for (const selectedSku of ["M1", "MV1", "展示样机", "单独转换线"]) {
  test(`rejects selected SKU ${selectedSku} even when the title contains 7506`, () => {
    const decision = new MatcherService().match(sonyRule, sonyOffer(selectedSku));

    assert.equal(decision.category, "REJECTED");
    assert.equal(decision.comparable, false);
    assert.ok(decision.reasons.some((reason) => reason.includes(selectedSku)));
  });
}

test("compares an exact 7506 bare SKU", () => {
  const decision = new MatcherService().match(sonyRule, sonyOffer("MDR-7506 单机"));

  assert.equal(decision.category, "BARE");
  assert.equal(decision.comparable, true);
});

const strictSonyRule = { ...sonyRule, effectiveAliases: [] };

test("accepts a Latin model directly beside Chinese product text", () => {
  const candidate = sonyOffer("监听耳机MDR-7506单机");
  candidate.title = "索尼专业监听耳机";

  const decision = new MatcherService().match(strictSonyRule, candidate);

  assert.equal(decision.category, "BARE");
  assert.equal(decision.comparable, true);
});

for (const continuation of ["XMDR-7506", "MDR-7506A", "MDR-75060"]) {
  test(`rejects model continuation ${continuation}`, () => {
    const candidate = sonyOffer(`${continuation} 单机`);
    candidate.title = "索尼专业监听耳机";

    const decision = new MatcherService().match(strictSonyRule, candidate);

    assert.equal(decision.category, "REJECTED");
    assert.equal(decision.comparable, false);
  });
}

test("keeps a pure-Han model bounded inside longer Chinese text", () => {
  const hanOnlyRule = {
    ...strictSonyRule,
    brand: "Antelope",
    standardModel: "羚羊"
  };
  const exact = sonyOffer("羚羊 单机");
  exact.title = "专业音频接口";
  const embedded = sonyOffer("小羚羊 单机");
  embedded.title = exact.title;

  const exactDecision = new MatcherService().match(hanOnlyRule, exact);
  const embeddedDecision = new MatcherService().match(hanOnlyRule, embedded);

  assert.equal(exactDecision.category, "BARE");
  assert.equal(exactDecision.comparable, true);
  assert.equal(embeddedDecision.category, "REJECTED");
  assert.equal(embeddedDecision.comparable, false);
});

test("compares an exact selected 7506 SKU on a title that lists 7506, M1, and MV1 variants", () => {
  const mixed = sonyOffer("MDR-7506 单机");
  mixed.title = "索尼 MDR-7506 / M1 / MV1 专业监听耳机 多规格可选";

  const decision = new MatcherService().match(sonyRule, mixed);

  assert.equal(decision.category, "BARE");
  assert.equal(decision.comparable, true);
});

test("keeps offer-wide risk terms active on mixed-variant titles", () => {
  const risky = sonyOffer("MDR-7506 单机");
  risky.title = "索尼 MDR-7506 / M1 / MV1 展示样机";

  const decision = new MatcherService().match(sonyRule, risky);

  assert.equal(decision.category, "REJECTED");
  assert.ok(decision.reasons.some((reason) => reason.includes("展示样机")));
});

test("does not conflate a 7506 plus conversion cable SKU with the bare SKU", () => {
  const decision = new MatcherService().match(
    sonyRule,
    sonyOffer("MDR-7506 + C口转换线", { 配置: "7506耳机+C口转换线" })
  );

  assert.equal(decision.category, "BUNDLE");
  assert.equal(decision.comparable, false);
  assert.ok(decision.reasons.some((reason) => reason.includes("转换线")));
});

test("requires an explicitly configured version in the title or selected SKU", () => {
  const versionedRule = { ...sonyRule, version: "新版" };

  const missing = new MatcherService().match(versionedRule, sonyOffer("MDR-7506 单机"));
  const inSku = new MatcherService().match(versionedRule, sonyOffer("MDR-7506 新版 单机"));
  const inAttributes = new MatcherService().match(
    versionedRule,
    sonyOffer("MDR-7506 单机", { 版本: "新版" })
  );

  assert.equal(missing.category, "REJECTED");
  assert.ok(missing.reasons.some((reason) => reason.includes("新版")));
  assert.equal(inSku.comparable, true);
  assert.equal(inAttributes.comparable, true);
});
