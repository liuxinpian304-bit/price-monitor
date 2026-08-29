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

test("ignores shipping-insurance copy when explicit shipping evidence is absent", async () => {
  const root = structuredClone(await fixture("live-item-x1-default.json"));
  removePriceEvidence(root, "运费");
  appendPriceEvidence(root, "退货运费险最高赔付 10.00", "服务");
  assert.equal(readSelectedSkuEvidence(root).mandatoryFeeText, "0.00");
});

test("ignores generic promotion headings", async () => {
  const root = structuredClone(await fixture("live-item-x1-default.json"));
  appendPriceEvidence(root, "优惠信息", "优惠");
  assert.deepEqual(readSelectedSkuEvidence(root).promotionTexts, ["满500减20", "88VIP专享"]);
});

test("reads an exact strikethrough subrole as live list-price evidence", async () => {
  const root = structuredClone(await fixture("live-item-x1-default.json"));
  const listPrice = priceEvidence(root, "原价");
  listPrice.value = "799.00";
  listPrice.description = "价格";
  listPrice.subrole = "AXStrikethrough";
  assert.equal(readSelectedSkuEvidence(root).listPriceText, "799.00");
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
    ["售罄", "OUT_OF_STOCK"],
    ["缺货", "OUT_OF_STOCK"]
  ];
  for (const [text, expected] of cases) {
    const root = structuredClone(await fixture("live-item-x1-default.json"));
    priceEvidence(root, "库存状态").value = text;
    assert.equal(readSelectedSkuEvidence(root).stockState, expected, text);
  }
});
