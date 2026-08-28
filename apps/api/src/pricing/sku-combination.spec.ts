import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSkuCombination,
  type SkuCombinationBuildResult,
  type SkuCombinationInput
} from "./sku-combination.ts";

type SkuComponent = NonNullable<SkuCombinationInput["components"]>[number];

const core: SkuComponent = {
  role: "CORE",
  accessoryType: "耳机",
  brand: " Sennheiser ",
  modelOrName: " HD 650 ",
  quantity: 1
};

const paidAccessory: SkuComponent = {
  role: "PAID_ACCESSORY",
  accessoryType: "耳机线",
  brand: "Sennheiser",
  modelOrName: "CH 650 S",
  quantity: 1
};

const remoteService: SkuComponent = {
  role: "GIFT_OR_SERVICE",
  accessoryType: "延保服务",
  brand: null,
  modelOrName: "两年延保",
  quantity: 1
};

function baseInput(overrides: Partial<SkuCombinationInput> = {}): SkuCombinationInput {
  return {
    productDecision: "BUNDLE",
    brand: "Sennheiser",
    standardModel: "HD 650",
    version: null,
    colorComparable: false,
    title: "森海塞尔 HD 650 套装",
    skuText: "标准版",
    attributes: {},
    components: [core],
    ...overrides
  };
}

function signed(result: SkuCombinationBuildResult): Extract<SkuCombinationBuildResult, { kind: "SIGNED" }> {
  assert.equal(result.kind, "SIGNED", result.reasons.join("；"));
  return result;
}

test("keeps a signature invariant when included components are reordered", () => {
  const first = signed(buildSkuCombination(baseInput({ components: [core, paidAccessory] })));
  const reordered = signed(buildSkuCombination(baseInput({ components: [paidAccessory, core] })));

  assert.equal(first.signature, reordered.signature);
});

test("changes a signature when an included component quantity changes", () => {
  const first = signed(buildSkuCombination(baseInput({ components: [core, paidAccessory] })));
  const twoUnits = signed(buildSkuCombination(baseInput({
    components: [{ ...core, quantity: 2 }, paidAccessory]
  })));

  assert.notEqual(first.signature, twoUnits.signature);
});

test("changes a signature when a paid accessory model changes", () => {
  const first = signed(buildSkuCombination(baseInput({ components: [core, paidAccessory] })));
  const changed = signed(buildSkuCombination(baseInput({
    components: [core, { ...paidAccessory, modelOrName: "CH 700 S" }]
  })));

  assert.notEqual(first.signature, changed.signature);
});

test("ignores gifts and services in the signature while recording a display reason", () => {
  const first = signed(buildSkuCombination(baseInput({ components: [core, paidAccessory] })));
  const giftChanged = signed(buildSkuCombination(baseInput({
    components: [core, paidAccessory, remoteService]
  })));

  assert.equal(first.signature, giftChanged.signature);
  assert.ok(giftChanged.reasons.some((reason) => reason.includes("赠品或服务")));
});

test("returns REVIEW without a signature for uncertain or incomplete component data", () => {
  const cases: Array<Partial<SkuCombinationInput>> = [
    { components: null },
    { components: [paidAccessory] },
    { components: [core, { ...paidAccessory, role: "UNKNOWN" }] },
    { components: [{ ...core, quantity: 0 }] },
    { components: [{ ...core, modelOrName: "  " }] },
    { components: [core, { ...remoteService, modelOrName: "  " }] }
  ];

  for (const overrides of cases) {
    const result = buildSkuCombination(baseInput(overrides));
    assert.equal(result.kind, "REVIEW");
    assert.equal(result.signature, null);
  }
});

test("returns REVIEW for product decisions that are not exact comparison decisions", () => {
  for (const productDecision of [null, "PENDING", "MANUAL"] as const) {
    const result = buildSkuCombination(baseInput({ productDecision }));
    assert.equal(result.kind, "REVIEW");
    assert.equal(result.signature, null);
  }
});

test("returns EXCLUDED for rejected products and non-new-condition text", () => {
  const rejected = buildSkuCombination(baseInput({ productDecision: "REJECTED" }));
  assert.equal(rejected.kind, "EXCLUDED");
  assert.equal(rejected.signature, null);

  for (const conditionText of ["二手", "样机", "展示机", "翻新", "租赁", "定金"]) {
    const result = buildSkuCombination(baseInput({ title: `HD 650 ${conditionText}` }));
    assert.equal(result.kind, "EXCLUDED", conditionText);
    assert.equal(result.signature, null);
  }
});

test("requires and hashes color only when color comparison is enabled", () => {
  const review = buildSkuCombination(baseInput({ colorComparable: true }));
  assert.equal(review.kind, "REVIEW");
  assert.equal(review.signature, null);

  const black = signed(buildSkuCombination(baseInput({
    colorComparable: true,
    attributes: { "颜色": "黑色" }
  })));
  const silver = signed(buildSkuCombination(baseInput({
    colorComparable: true,
    attributes: { "颜色": "银色" }
  })));
  assert.notEqual(black.signature, silver.signature);

  const disabledBlack = signed(buildSkuCombination(baseInput({
    attributes: { "颜色": "黑色" }
  })));
  const disabledSilver = signed(buildSkuCombination(baseInput({
    attributes: { "颜色": "银色" }
  })));
  assert.equal(disabledBlack.signature, disabledSilver.signature);
  assert.equal(disabledBlack.canonical.color, null);
});

test("hashes normalized material version region and warranty attributes", () => {
  const first = signed(buildSkuCombination(baseInput({
    attributes: {
      "版本": " 国行版 ",
      "地区": "中国大陆",
      "质保": "2 年",
      "包装": "礼盒"
    }
  })));
  const changed = signed(buildSkuCombination(baseInput({
    attributes: {
      "版本": "港版",
      "地区": "中国大陆",
      "质保": "2 年",
      "包装": "普通包装"
    }
  })));

  assert.notEqual(first.signature, changed.signature);
  assert.deepEqual(first.canonical.attributes, [
    { key: "地区", value: "中国大陆" },
    { key: "版本", value: "国行版" },
    { key: "质保", value: "2 年" }
  ]);
});

test("emits the versioned lowercase SHA-256 signature from normalized text", () => {
  const first = signed(buildSkuCombination(baseInput({
    brand: "ＳＥＮＮＨＥＩＳＥＲ",
    standardModel: "HD－650",
    components: [{ ...core, brand: "SENNHEISER", modelOrName: "HD－650" }]
  })));
  const normalized = signed(buildSkuCombination(baseInput()));

  assert.equal(first.signature, normalized.signature);
  assert.match(first.signature, /^sku-combination-v1:[a-f0-9]{64}$/);
});
