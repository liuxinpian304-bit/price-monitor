import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { UiContractChangedError } from "../../core/desktop-driver.ts";
import { findAxNode, type AxNode } from "./ax-node.ts";
import { readSelectedSkuEvidence } from "./taobao-price-evidence.ts";

async function fixture(name: string): Promise<AxNode> {
  const url = new URL(`../../../test/fixtures/ax/${name}`, import.meta.url);
  return JSON.parse(await readFile(url, "utf8")) as AxNode;
}

function detailArea(root: AxNode): AxNode {
  return findAxNode(root, (node) => node.role === "AXWebArea" && node.title === "商品详情")
    ?? assert.fail("detail web area is missing");
}

function purchaseRegion(root: AxNode): AxNode {
  return detailArea(root).children[0] ?? assert.fail("purchase region is missing");
}

function priceRegion(root: AxNode): AxNode {
  return purchaseRegion(root).children.find((node) => node.description === "已选规格价格")
    ?? assert.fail("selected-SKU price region is missing");
}

function staticText(path: number[], value: string, description: string): AxNode {
  return {
    path,
    role: "AXStaticText",
    subrole: null,
    identifier: null,
    title: null,
    description,
    value,
    url: null,
    enabled: null,
    selected: null,
    position: null,
    size: null,
    actions: [],
    children: []
  };
}

function appendPriceEvidence(root: AxNode, value: string, description = "价格"): void {
  const region = priceRegion(root);
  region.children.push(staticText([...region.path, region.children.length], value, description));
}

function priceEvidence(root: AxNode, description: string): AxNode {
  return priceRegion(root).children.find((node) => node.description === description)
    ?? assert.fail(`${description} evidence is missing`);
}

function removePriceEvidence(root: AxNode, description: string): void {
  const region = priceRegion(root);
  region.children = region.children.filter((node) => node.description !== description);
}

function recommendationRegion(root: AxNode): AxNode {
  return detailArea(root).children.find((node) => node.description === "相关推荐")
    ?? assert.fail("recommendation region is missing");
}

function domPurchaseRegion(root: AxNode): AxNode {
  return detailArea(root).children[0] ?? assert.fail("DOM purchase region is missing");
}

function domPriceRegion(root: AxNode): AxNode {
  return domPurchaseRegion(root).children[2] ?? assert.fail("DOM price region is missing");
}

function domRecommendationRegion(root: AxNode): AxNode {
  return detailArea(root).children[1] ?? assert.fail("DOM recommendation region is missing");
}

function domPriceGroup(root: AxNode, label: string): AxNode {
  return domPriceRegion(root).children.find((group) =>
    group.children.some((child) => child.value === label)) ?? assert.fail(`${label} group is missing`);
}

function appendDomPriceGroup(root: AxNode, label: string, amount: string): void {
  const region = domPriceRegion(root);
  const index = region.children.length;
  region.children.push({
    path: [...region.path, index],
    role: "AXGroup",
    subrole: null,
    identifier: null,
    title: null,
    description: null,
    value: null,
    url: null,
    enabled: true,
    selected: null,
    position: null,
    size: null,
    actions: [],
    children: [
      staticText([...region.path, index, 0], label, "价格标签"),
      staticText([...region.path, index, 1], amount, "价格金额")
    ]
  });
}

function replaceDomPromotionWithEnjoyedPromotion(root: AxNode, label: string): void {
  const region = domPurchaseRegion(root);
  region.children = region.children.filter((node) => node.value !== "满500减20");
  const index = region.children.length;
  region.children.push({
    path: [...region.path, index],
    role: "AXGroup",
    subrole: null,
    identifier: null,
    title: null,
    description: null,
    value: null,
    url: null,
    enabled: true,
    selected: null,
    position: null,
    size: null,
    actions: [],
    domClassList: ["couponInfoArea--fixture"],
    children: [
      staticText([...region.path, index, 0], "已享受:", "优惠状态"),
      staticText([...region.path, index, 1], label, "优惠")
    ]
  });
}

test("reads selected live SKU evidence only from the purchase region", async () => {
  const evidence = readSelectedSkuEvidence(await fixture("live-item-x1-default.json"));
  assert.equal(evidence.listPriceText, "799.00");
  assert.equal(evidence.activityPriceText, "699.00");
  assert.equal(evidence.officialEstimatedPayablePriceText, "679.00");
  assert.equal(evidence.mandatoryFeeText, "0.00");
  assert.equal(evidence.stockState, "IN_STOCK");
  assert.deepEqual(evidence.promotionTexts, ["满500减20", "88VIP专享"]);
});

test("uses activity price as list price when no explicit list price exists", async () => {
  const evidence = readSelectedSkuEvidence(await fixture("live-item-x1-bundle.json"));
  assert.equal(evidence.listPriceText, "899.00");
  assert.equal(evidence.activityPriceText, "899.00");
  assert.equal(evidence.stockState, "OUT_OF_STOCK");
});

test("keeps semantic-live price evidence authoritative when DOM classes are also exposed", async () => {
  const root = structuredClone(await fixture("live-item-x1-default.json"));
  priceRegion(root).domClassList = ["price--semantic-fixture"];

  const evidence = readSelectedSkuEvidence(root);
  assert.equal(evidence.listPriceText, "799.00");
  assert.equal(evidence.activityPriceText, "699.00");
});

test("keeps the selected DOM price profile authoritative over a stray semantic marker", async () => {
  const root = structuredClone(await fixture("live-dom-item-x1-default.json"));
  const region = domPurchaseRegion(root);
  const index = region.children.length;
  region.children.push({
    path: [...region.path, index],
    role: "AXGroup",
    subrole: null,
    identifier: null,
    title: null,
    description: "已选规格价格",
    value: null,
    url: null,
    enabled: true,
    selected: null,
    position: null,
    size: null,
    actions: [],
    children: [
      staticText([...region.path, index, 0], "活动价 199.00", "活动价"),
      staticText([...region.path, index, 1], "原价 299.00", "原价")
    ]
  });

  const evidence = readSelectedSkuEvidence(root);
  assert.equal(evidence.listPriceText, "799.00");
  assert.equal(evidence.activityPriceText, "699.00");
});

test("reads explicit DOM-backed selected-SKU evidence only from its purchase region", async () => {
  const evidence = readSelectedSkuEvidence(await fixture("live-dom-item-x1-default.json"));

  assert.equal(evidence.listPriceText, "799.00");
  assert.equal(evidence.activityPriceText, "699.00");
  assert.equal(evidence.officialEstimatedPayablePriceText, null);
  assert.equal(evidence.mandatoryFeeText, "0.00");
  assert.equal(evidence.stockState, "IN_STOCK");
  assert.deepEqual(evidence.promotionTexts, ["满500减20"]);
});

test("reads the current free-shipping copy without treating return benefits as delivery fees", async () => {
  const root = structuredClone(await fixture("live-dom-item-x1-default.json"));
  const shipping = findAxNode(domPurchaseRegion(root), (node) => node.value === "包邮")
    ?? assert.fail("free-shipping evidence is missing");
  shipping.value = "快递: 免运费";
  const region = domPurchaseRegion(root);
  region.children.push(staticText(
    [...region.path, region.children.length],
    "88VIP退货包运费",
    "服务权益"
  ));

  assert.equal(readSelectedSkuEvidence(root).mandatoryFeeText, "0.00");
});

test("reads selected-SKU evidence from the current price-wrap profile", async () => {
  const root = structuredClone(await fixture("live-dom-item-x1-default.json"));
  const region = domPriceRegion(root);
  region.domClassList = ["priceWrap--fixture"];
  region.children = [
    staticText([...region.path, 0], "店铺优惠后", "价格标签"),
    staticText([...region.path, 1], "￥", "币种"),
    staticText([...region.path, 2], "699", "价格金额"),
    staticText([...region.path, 3], "优惠前", "价格标签"),
    staticText([...region.path, 4], "￥", "币种"),
    staticText([...region.path, 5], "799.00", "价格金额")
  ];
  const purchaseButton = domPurchaseRegion(root).children[8] ?? assert.fail("purchase button is missing");
  purchaseButton.title = "领券购买";

  const evidence = readSelectedSkuEvidence(root);
  assert.equal(evidence.listPriceText, "799.00");
  assert.equal(evidence.activityPriceText, "699.00");
});

test("reads one strict undiscounted price-wrap amount as list and activity price", async () => {
  const root = structuredClone(await fixture("live-dom-item-x1-default.json"));
  const region = domPriceRegion(root);
  region.domClassList = ["priceWrap--fixture"];
  region.children = [
    staticText([...region.path, 0], "￥", ""),
    staticText([...region.path, 1], "12200", "")
  ];

  const evidence = readSelectedSkuEvidence(root);
  assert.equal(evidence.listPriceText, "12200.00");
  assert.equal(evidence.activityPriceText, "12200.00");
});

test("rejects an unlabeled price-wrap containing another numeric value", async () => {
  const root = structuredClone(await fixture("live-dom-item-x1-default.json"));
  const region = domPriceRegion(root);
  region.domClassList = ["priceWrap--fixture"];
  region.children = [
    staticText([...region.path, 0], "￥", ""),
    staticText([...region.path, 1], "12200", ""),
    staticText([...region.path, 2], "4067", "")
  ];

  assert.throws(() => readSelectedSkuEvidence(root), UiContractChangedError);
});

test("marks an exact enjoyed reduction as already included in the current DOM price", async () => {
  const root = structuredClone(await fixture("live-dom-item-x1-default.json"));
  replaceDomPromotionWithEnjoyedPromotion(root, "立减100元");

  const promotion = readSelectedSkuEvidence(root).promotions[0];

  assert.equal(promotion?.label, "立减100元");
  assert.equal(promotion?.includedInActivityPrice, true);
  assert.equal(promotion?.activityPriceInclusion, "INCLUDED");
});

test("does not infer inclusion when an enjoyed reduction differs from the displayed price gap", async () => {
  const root = structuredClone(await fixture("live-dom-item-x1-default.json"));
  replaceDomPromotionWithEnjoyedPromotion(root, "立减99元");

  const promotion = readSelectedSkuEvidence(root).promotions[0];

  assert.equal(promotion?.includedInActivityPrice, false);
  assert.equal(promotion?.activityPriceInclusion, "UNKNOWN");
});

test("rejects duplicate activity labels in the flat current price-wrap profile", async () => {
  const root = structuredClone(await fixture("live-dom-item-x1-default.json"));
  const region = domPriceRegion(root);
  region.domClassList = ["priceWrap--fixture"];
  region.children = [
    staticText([...region.path, 0], "店铺优惠后", "价格标签"),
    staticText([...region.path, 1], "￥", "币种"),
    staticText([...region.path, 2], "699", "价格金额"),
    staticText([...region.path, 3], "活动价", "价格标签"),
    staticText([...region.path, 4], "￥", "币种"),
    staticText([...region.path, 5], "698", "价格金额"),
    staticText([...region.path, 6], "优惠前", "价格标签"),
    staticText([...region.path, 7], "￥", "币种"),
    staticText([...region.path, 8], "799.00", "价格金额")
  ];

  assert.throws(() => readSelectedSkuEvidence(root), UiContractChangedError);
});

test("reads the changed current price from the DOM-backed bundle fixture", async () => {
  const evidence = readSelectedSkuEvidence(await fixture("live-dom-item-x1-bundle.json"));

  assert.equal(evidence.listPriceText, "799.00");
  assert.equal(evidence.activityPriceText, "899.00");
  assert.equal(evidence.mandatoryFeeText, "0.00");
  assert.equal(evidence.stockState, "IN_STOCK");
  assert.deepEqual(evidence.promotionTexts, ["满500减20"]);
});

test("rejects two DOM-backed current-price groups", async () => {
  const root = structuredClone(await fixture("live-dom-item-x1-default.json"));
  appendDomPriceGroup(root, "活动到手价", "698.00");

  assert.throws(() => readSelectedSkuEvidence(root), UiContractChangedError);
});

test("rejects two DOM-backed list-price groups", async () => {
  const root = structuredClone(await fixture("live-dom-item-x1-default.json"));
  appendDomPriceGroup(root, "原价", "798.00");

  assert.throws(() => readSelectedSkuEvidence(root), UiContractChangedError);
});

test("rejects conflicting DOM-backed stock states", async () => {
  const root = structuredClone(await fixture("live-dom-item-x1-default.json"));
  const region = domPurchaseRegion(root);
  region.children.push(staticText([...region.path, region.children.length], "无货", "库存状态"));

  assert.throws(() => readSelectedSkuEvidence(root), UiContractChangedError);
});

test("rejects malformed DOM-backed price precision", async () => {
  const root = structuredClone(await fixture("live-dom-item-x1-default.json"));
  const group = domPriceGroup(root, "店铺优惠后");
  group.children[1] = staticText([...group.path, 1], "699.000", "价格金额");

  assert.throws(() => readSelectedSkuEvidence(root), TypeError);
});

test("ignores recommendation prices outside the DOM-backed purchase region", async () => {
  const root = structuredClone(await fixture("live-dom-item-x1-default.json"));
  const recommendations = domRecommendationRegion(root);
  recommendations.children.push(staticText(
    [...recommendations.path, recommendations.children.length],
    "活动到手价 1.999",
    "推荐价格"
  ));

  const evidence = readSelectedSkuEvidence(root);
  assert.equal(evidence.listPriceText, "799.00");
  assert.equal(evidence.activityPriceText, "699.00");
});

test("ignores shipping evidence outside the DOM-backed purchase region", async () => {
  const root = structuredClone(await fixture("live-dom-item-x1-default.json"));
  const recommendations = domRecommendationRegion(root);
  recommendations.children.push(staticText(
    [...recommendations.path, recommendations.children.length],
    "运费 12.50",
    "运费"
  ));

  assert.equal(readSelectedSkuEvidence(root).mandatoryFeeText, "0.00");
});

test("ignores stock evidence outside the DOM-backed purchase region", async () => {
  const root = structuredClone(await fixture("live-dom-item-x1-default.json"));
  const recommendations = domRecommendationRegion(root);
  recommendations.children.push(staticText(
    [...recommendations.path, recommendations.children.length],
    "无货",
    "库存状态"
  ));

  assert.equal(readSelectedSkuEvidence(root).stockState, "IN_STOCK");
});

test("ignores promotion evidence outside the DOM-backed purchase region", async () => {
  const root = structuredClone(await fixture("live-dom-item-x1-default.json"));
  const recommendations = domRecommendationRegion(root);
  recommendations.children.push(staticText(
    [...recommendations.path, recommendations.children.length],
    "50元券",
    "优惠"
  ));

  assert.deepEqual(readSelectedSkuEvidence(root).promotionTexts, ["满500减20"]);
});

test("rejects distinct live activity prices in the purchase region", async () => {
  const root = structuredClone(await fixture("live-item-x1-default.json"));
  appendPriceEvidence(root, "活动到手价 698.00", "活动到手价");
  assert.throws(() => readSelectedSkuEvidence(root), UiContractChangedError);
});

test("rejects distinct live explicit list prices in the purchase region", async () => {
  const root = structuredClone(await fixture("live-item-x1-default.json"));
  appendPriceEvidence(root, "划线价 798.00", "划线价");
  assert.throws(() => readSelectedSkuEvidence(root), UiContractChangedError);
});

test("rejects conflicting live stock states in the purchase region", async () => {
  const root = structuredClone(await fixture("live-item-x1-default.json"));
  appendPriceEvidence(root, "无货", "库存状态");
  assert.throws(() => readSelectedSkuEvidence(root), UiContractChangedError);
});

test("rejects malformed live price precision in the purchase region", async () => {
  const root = structuredClone(await fixture("live-item-x1-default.json"));
  priceEvidence(root, "活动价").value = "活动价 699.000";
  assert.throws(() => readSelectedSkuEvidence(root), TypeError);
});

test("rejects unrelated activity keyword copy when the semantic activity price is absent", async () => {
  const root = structuredClone(await fixture("live-item-x1-default.json"));
  removePriceEvidence(root, "活动价");
  appendPriceEvidence(root, "2026 活动价精选商品", "商品文案");
  assert.throws(() => readSelectedSkuEvidence(root), UiContractChangedError);
});

test("rejects arbitrary one-number values behind an exact activity label", async () => {
  const root = structuredClone(await fixture("live-item-x1-default.json"));
  priceEvidence(root, "活动价").value = "新品编号 2026";
  assert.throws(() => readSelectedSkuEvidence(root), UiContractChangedError);
});

test("fails closed when explicit shipping evidence is absent", async () => {
  const root = structuredClone(await fixture("live-item-x1-default.json"));
  removePriceEvidence(root, "运费");
  appendPriceEvidence(root, "退货运费险最高赔付 10.00", "服务");
  assert.throws(() => readSelectedSkuEvidence(root), UiContractChangedError);
});

test("reads shipping evidence described as a delivery service", async () => {
  const root = structuredClone(await fixture("live-item-x1-default.json"));
  const shipping = priceEvidence(root, "运费");
  shipping.value = "运费 12.50";
  shipping.description = "配送服务";
  assert.equal(readSelectedSkuEvidence(root).mandatoryFeeText, "12.50");
});

test("ignores generic promotion headings", async () => {
  const root = structuredClone(await fixture("live-item-x1-default.json"));
  appendPriceEvidence(root, "优惠信息", "优惠");
  assert.deepEqual(readSelectedSkuEvidence(root).promotionTexts, ["满500减20", "88VIP专享"]);
});

test("ignores generic audience-benefit headings", async () => {
  for (const heading of ["88VIP", "88VIP权益", "会员权益"]) {
    const root = structuredClone(await fixture("live-item-x1-default.json"));
    appendPriceEvidence(root, heading, "优惠");
    assert.deepEqual(readSelectedSkuEvidence(root).promotionTexts, ["满500减20", "88VIP专享"], heading);
  }
});

test("retains an unrecognized eligibility promotion for manual review", async () => {
  const root = structuredClone(await fixture("live-item-x1-default.json"));
  appendPriceEvidence(root, "新客专享立减资格待确认", "优惠");
  const evidence = readSelectedSkuEvidence(root);

  assert.ok(evidence.promotionTexts.includes("新客专享立减资格待确认"));
  assert.equal(
    evidence.promotions.find((promotion) => promotion.label === "新客专享立减资格待确认")?.audience,
    "UNKNOWN"
  );
});

test("reads an exact strikethrough subrole as live list-price evidence", async () => {
  const root = structuredClone(await fixture("live-item-x1-default.json"));
  const listPrice = priceEvidence(root, "原价");
  listPrice.value = "799.00";
  listPrice.description = "价格";
  listPrice.subrole = "AXStrikethrough";
  assert.equal(readSelectedSkuEvidence(root).listPriceText, "799.00");
});

test("ignores a strikethrough node whose text is not amount-only", async () => {
  const root = structuredClone(await fixture("live-item-x1-default.json"));
  const listPrice = priceEvidence(root, "原价");
  listPrice.value = "优惠失效 88.00";
  listPrice.description = "价格";
  listPrice.subrole = "AXStrikethrough";
  assert.equal(readSelectedSkuEvidence(root).listPriceText, "699.00");
});

test("ignores recommendation prices outside the live purchase region", async () => {
  const root = structuredClone(await fixture("live-item-x1-default.json"));
  const recommendations = recommendationRegion(root);
  recommendations.children.push(staticText(
    [...recommendations.path, recommendations.children.length],
    "活动价 1.999",
    "推荐价格"
  ));
  const evidence = readSelectedSkuEvidence(root);
  assert.equal(evidence.listPriceText, "799.00");
  assert.equal(evidence.activityPriceText, "699.00");
});

test("deduplicates live promotion labels without changing the activity price", async () => {
  const root = structuredClone(await fixture("live-item-x1-default.json"));
  appendPriceEvidence(root, "满500减20", "优惠");
  const evidence = readSelectedSkuEvidence(root);
  assert.equal(evidence.activityPriceFen, 69_900);
  assert.deepEqual(evidence.promotionTexts, ["满500减20", "88VIP专享"]);
  assert.equal(evidence.promotions.every((promotion) => promotion.includedInActivityPrice === false), true);
});

test("reads explicit live shipping fees", async () => {
  const root = structuredClone(await fixture("live-item-x1-default.json"));
  priceEvidence(root, "运费").value = "运费 12.50";
  const evidence = readSelectedSkuEvidence(root);
  assert.equal(evidence.mandatoryFeeText, "12.50");
});

test("maps the supported explicit live stock text", async () => {
  const cases: Array<[string, "IN_STOCK" | "OUT_OF_STOCK"]> = [
    ["现货", "IN_STOCK"],
    ["库存充足", "IN_STOCK"],
    ["即将售罄", "IN_STOCK"],
    ["售罄", "OUT_OF_STOCK"],
    ["缺货", "OUT_OF_STOCK"]
  ];
  for (const [text, expected] of cases) {
    const root = structuredClone(await fixture("live-item-x1-default.json"));
    priceEvidence(root, "库存状态").value = text;
    assert.equal(readSelectedSkuEvidence(root).stockState, expected, text);
  }
});
