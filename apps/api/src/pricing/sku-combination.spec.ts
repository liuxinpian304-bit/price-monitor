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

test("ignores component type and brand context when model and quantity are identical", () => {
  const first = signed(buildSkuCombination(baseInput({ components: [core, paidAccessory] })));
  const changedContext = signed(buildSkuCombination(baseInput({
    components: [
      { ...core, accessoryType: "开放式监听耳机", brand: "Acme" },
      { ...paidAccessory, accessoryType: "平衡线", brand: null }
    ]
  })));

  assert.equal(first.signature, changedContext.signature);
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
  assert.deepEqual(first.canonical.materialAttributes, {
    "地区": "中国大陆",
    "版本": "国行版",
    "质保": "2 年"
  });
});

test("normalizes resolved identifiers with compact matcher formatting semantics", () => {
  const first = signed(buildSkuCombination(baseInput({
    brand: "ＳＥＮＮＨＥＩＳＥＲ",
    standardModel: "HD－650",
    components: [{ ...core, modelOrName: "HD－650" }]
  })));
  const equivalent = signed(buildSkuCombination(baseInput({
    brand: "sennheiser",
    standardModel: " h d 6 5 0 ",
    components: [{ ...core, modelOrName: "h d 6 5 0" }]
  })));

  assert.equal(first.signature, equivalent.signature);
  assert.equal(first.canonical.brand, "sennheiser");
  assert.equal(first.canonical.model, "hd650");
  assert.match(first.signature, /^sku-combination-v1:[a-f0-9]{64}$/);
});

test("treats overlapping color-version attributes as color only", () => {
  const withoutColorComparison = signed(buildSkuCombination(baseInput()));
  const overlappingDisabled = signed(buildSkuCombination(baseInput({
    attributes: { "颜色版本": "珍珠白" }
  })));
  assert.equal(withoutColorComparison.signature, overlappingDisabled.signature);
  assert.equal(overlappingDisabled.canonical.color, null);
  assert.deepEqual(overlappingDisabled.canonical.materialAttributes, {});

  const overlappingEnabled = signed(buildSkuCombination(baseInput({
    colorComparable: true,
    attributes: { "颜色版本": "珍珠白" }
  })));
  assert.equal(overlappingEnabled.canonical.color, "珍珠白");
  assert.deepEqual(overlappingEnabled.canonical.materialAttributes, {});
});

test("refuses malformed quantities and empty material or color values", () => {
  for (const quantity of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const result = buildSkuCombination(baseInput({ components: [{ ...core, quantity }] }));
    assert.equal(result.kind, "REVIEW", String(quantity));
    assert.equal(result.signature, null);
  }

  for (const attributes of [{ "版本": "  " }, { "颜色": " " }]) {
    const result = buildSkuCombination(baseInput({ colorComparable: true, attributes }));
    assert.equal(result.kind, "REVIEW");
    assert.equal(result.signature, null);
  }
});

test("matches the documented fixed canonical JSON and SHA-256 golden vector", () => {
  const result = signed(buildSkuCombination(baseInput({
    productDecision: "BARE",
    brand: "RODE",
    standardModel: "NT1S",
    components: [{ ...core, modelOrName: "NT1S" }]
  })));

  assert.deepEqual(result.canonical, {
    version: "sku-combination-v1",
    brand: "rode",
    model: "nt1s",
    condition: "new",
    core: [{ model: "nt1s", quantity: 1 }],
    paidAccessories: [],
    materialAttributes: {},
    color: null
  });
  assert.equal(result.signature, "sku-combination-v1:1da55ef5c6dc23f37296842567c5167f85a8d2ce106dea66667aa87ef7eae21b");
});
