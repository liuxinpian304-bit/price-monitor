import assert from "node:assert/strict";
import test from "node:test";

import { collectorJobSchema, collectorReportSchema } from "./desktop-collector.ts";

const job = {
  schemaVersion: 1,
  runId: "run-1",
  collectorId: "collector-mac-1",
  monitoredModelId: "model-1",
  searchQuery: "索尼 7506",
  searchLimit: 50,
  ownShopName: "星空乐器专营店",
  ownListings: [{ id: "own-1", url: "https://detail.tmall.com/item.htm?id=own-1", skuText: "7506 单机" }],
  rule: {
    brand: "Sony",
    standardModel: "MDR-7506",
    version: null,
    comparisonType: "BARE",
    effectiveAliases: ["7506"],
    excludedAliases: ["M1", "MV1"],
    mustIncludeTerms: ["7506"],
    excludedTerms: ["二手", "样机", "单独线材"]
  }
} as const;

const capturedAt = "2026-08-24T01:30:00.000Z";

function sku(itemId: string, skuId: string) {
  return {
    skuId,
    label: "7506 单机",
    attributes: { configuration: "BARE" },
    stockState: "IN_STOCK" as const,
    listPriceFen: 77_500,
    activityPriceFen: 65_800,
    couponDiscountFen: 2_000,
    fullReductionFen: 1_000,
    directDiscountFen: 0,
    promotions: [
      {
        kind: "COUPON",
        label: "满600减20",
        amountFen: 2_000,
        thresholdFen: 60_000,
        audience: "PUBLIC",
        stackGroup: "shop-coupon",
        includedInActivityPrice: false
      }
    ],
    mandatoryFeeFen: 0,
    priceConfidence: "CONFIRMED" as const,
    payableFen: 62_800,
    capturedAt,
    evidenceKey: `sha256:${Buffer.from(itemId).toString("hex").padEnd(64, "0")}`
  };
}

const position = (rank: number) => ({
  rank,
  platformItemId: `item-${rank}`,
  url: `https://item.taobao.com/item.htm?id=${rank}`,
  shopName: `店铺${rank}`,
  title: `索尼 7506 商品${rank}`,
  displayPriceMinFen: 65_800,
  displayPriceMaxFen: 65_800,
  sponsored: false,
  capturedAt
});

const report = {
  schemaVersion: 1,
  runId: "run-1",
  collectorId: "collector-mac-1",
  appVersion: "2.4.5",
  startedAt: "2026-08-24T01:30:00.000Z",
  completedAt: "2026-08-24T01:40:00.000Z",
  status: "SUCCEEDED",
  searchLimit: 50,
  positions: Array.from({ length: 50 }, (_, index) => position(index + 1)),
  ownItems: [
    {
      ownListingId: "own-1",
      platformItemId: "own-item",
      url: "https://detail.tmall.com/item.htm?id=own-item",
      shopName: "星空乐器专营店",
      title: "索尼 MDR-7506",
      searchRanks: [],
      skus: [sku("own-item", "own-sku")]
    }
  ],
  competitorItems: [
    {
      platformItemId: "competitor-1",
      url: "https://item.taobao.com/item.htm?id=competitor-1",
      shopName: "同行一",
      title: "索尼 MDR-7506",
      searchRanks: [1],
      skus: [sku("competitor-1", "competitor-sku-1")]
    },
    {
      platformItemId: "competitor-2",
      url: "https://item.taobao.com/item.htm?id=competitor-2",
      shopName: "同行二",
      title: "索尼 MDR-7506",
      searchRanks: [2],
      skus: [sku("competitor-2", "competitor-sku-2")]
    }
  ],
  issues: []
} as const;

test("accepts the approved first-50 all-SKU job contract", () => {
  assert.equal(collectorJobSchema.parse(job).searchLimit, 50);
});

test("accepts a report with one own SKU and two competitor SKUs", () => {
  const parsed = collectorReportSchema.parse(report);

  assert.equal(parsed.ownItems[0]?.skus.length, 1);
  assert.equal(parsed.competitorItems.length, 2);
  assert.equal(parsed.competitorItems[0]?.skus.length, 1);
});

test("rejects missing ranks, unsafe money, invalid confidence, and excess positions", () => {
  assert.throws(() => collectorReportSchema.parse({
    ...report,
    positions: report.positions.map((entry, index) => index === 1 ? { ...entry, rank: 3 } : entry)
  }));
  assert.throws(() => collectorReportSchema.parse({
    ...report,
    ownItems: [{
      ...report.ownItems[0],
      skus: [{ ...report.ownItems[0].skus[0], listPriceFen: -1 }]
    }]
  }));
  assert.throws(() => collectorReportSchema.parse({
    ...report,
    competitorItems: [{
      ...report.competitorItems[0],
      skus: [{ ...report.competitorItems[0].skus[0], priceConfidence: "UNKNOWN" }]
    }, report.competitorItems[1]]
  }));
  assert.throws(() => collectorReportSchema.parse({
    ...report,
    positions: [...report.positions, { ...report.positions[0]!, rank: 51 }]
  }));
});

test("rejects unknown fields at every contract boundary", () => {
  assert.throws(() => collectorJobSchema.parse({ ...job, unexpected: true }));
  assert.throws(() => collectorReportSchema.parse({ ...report, unexpected: true }));
});
