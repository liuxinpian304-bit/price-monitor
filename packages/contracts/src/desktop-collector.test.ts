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

const position = (rank: number, platformItemId = `item-${rank}`) => ({
  rank,
  platformItemId,
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
  positions: Array.from({ length: 50 }, (_, index) => position(
    index + 1,
    index === 0 ? "competitor-1" : index === 1 ? "competitor-2" : undefined
  )),
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

test("requires claimed jobs and successful reports to include an own listing", () => {
  assert.throws(() => collectorJobSchema.parse({ ...job, ownListings: [] }));
  assert.throws(() => collectorReportSchema.parse({ ...report, ownItems: [] }));

  for (const status of ["PARTIAL_FAILED", "FAILED"] as const) {
    assert.doesNotThrow(() => collectorReportSchema.parse({
      ...report,
      status,
      positions: [],
      ownItems: [],
      competitorItems: [],
      issues: [{
        code: "APP_VERSION_UNSUPPORTED" as const,
        message: "Collector could not start",
        capturedAt
      }]
    }));
  }
});

test("accepts a report with one own SKU and two competitor SKUs", () => {
  const parsed = collectorReportSchema.parse(report);

  assert.equal(parsed.ownItems[0]?.skus.length, 1);
  assert.equal(parsed.competitorItems.length, 2);
  assert.equal(parsed.competitorItems[0]?.skus.length, 1);
});

test("accepts optional structured bundle components and rejects ambiguous component data", () => {
  const components = [
    { accessoryType: "耳机", brand: "Sony", modelOrName: "MDR-7506", quantity: 1 },
    { accessoryType: "转换线", brand: null, modelOrName: "C口转换线", quantity: 1 }
  ];
  const withComponents = {
    ...report,
    competitorItems: [{
      ...report.competitorItems[0],
      skus: [{ ...report.competitorItems[0].skus[0], components }]
    }, report.competitorItems[1]]
  };

  const parsed = collectorReportSchema.parse(withComponents);

  assert.deepEqual(parsed.competitorItems[0]?.skus[0]?.components, components);
  assert.doesNotThrow(() => collectorReportSchema.parse(report));
  assert.throws(() => collectorReportSchema.parse({
    ...withComponents,
    competitorItems: [{
      ...withComponents.competitorItems[0],
      skus: [{ ...withComponents.competitorItems[0].skus[0], components: [{ ...components[0], quantity: 0 }] }]
    }, withComponents.competitorItems[1]]
  }));
  assert.throws(() => collectorReportSchema.parse({
    ...withComponents,
    competitorItems: [{
      ...withComponents.competitorItems[0],
      skus: [{
        ...withComponents.competitorItems[0].skus[0],
        components: [{ ...components[0], unstructuredDetail: "two units" }]
      }]
    }, withComponents.competitorItems[1]]
  }));
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

test("enforces the confirmed payable price formula", () => {
  assert.doesNotThrow(() => collectorReportSchema.parse(report));
  assert.throws(() => collectorReportSchema.parse({
    ...report,
    competitorItems: [{
      ...report.competitorItems[0],
      skus: [{ ...report.competitorItems[0].skus[0], payableFen: 62_801 }]
    }, report.competitorItems[1]]
  }));
  assert.throws(() => collectorReportSchema.parse({
    ...report,
    competitorItems: [{
      ...report.competitorItems[0],
      skus: [{
        ...report.competitorItems[0].skus[0],
        couponDiscountFen: 70_000,
        payableFen: 0
      }]
    }, report.competitorItems[1]]
  }));
});

test("accepts nullable uncertain promotion details and limits payable null to manual review", () => {
  const manualReviewReport = {
    ...report,
    competitorItems: [{
      ...report.competitorItems[0],
      skus: [{
        ...report.competitorItems[0].skus[0],
        priceConfidence: "MANUAL_REVIEW" as const,
        payableFen: null,
        promotions: [{
          ...report.competitorItems[0].skus[0].promotions[0],
          amountFen: null,
          thresholdFen: null,
          stackGroup: null
        }]
      }]
    }, report.competitorItems[1]]
  };
  assert.doesNotThrow(() => collectorReportSchema.parse(manualReviewReport));
  assert.doesNotThrow(() => collectorReportSchema.parse({
    ...manualReviewReport,
    competitorItems: [{
      ...manualReviewReport.competitorItems[0],
      skus: [{ ...manualReviewReport.competitorItems[0].skus[0], payableFen: 62_800 }]
    }, manualReviewReport.competitorItems[1]]
  }));
  assert.throws(() => collectorReportSchema.parse({
    ...report,
    competitorItems: [{
      ...report.competitorItems[0],
      skus: [{
        ...report.competitorItems[0].skus[0],
        priceConfidence: "ESTIMATED" as const,
        payableFen: null
      }]
    }, report.competitorItems[1]]
  }));
});

test("requires a matching issue for items with no collected SKUs", () => {
  const emptyItemReport = {
    ...report,
    competitorItems: [{ ...report.competitorItems[0], skus: [] }, report.competitorItems[1]],
    issues: [{
      code: "ITEM_UNAVAILABLE" as const,
      message: "商品已下架",
      platformItemId: "competitor-1",
      capturedAt
    }]
  };
  assert.doesNotThrow(() => collectorReportSchema.parse(emptyItemReport));
  assert.throws(() => collectorReportSchema.parse({ ...emptyItemReport, issues: [] }));
  assert.throws(() => collectorReportSchema.parse({
    ...emptyItemReport,
    issues: [{ ...emptyItemReport.issues[0], platformItemId: "competitor-2" }]
  }));
});

test("requires item-level issue codes to identify their item", () => {
  for (const code of ["SKU_ENUMERATION_INCOMPLETE", "SKU_SELECTION_MISMATCH", "PRICE_UNSTABLE"] as const) {
    assert.throws(() => collectorReportSchema.parse({
      ...report,
      issues: [{ code, message: "需要复核", capturedAt }]
    }));
  }
});

test("bounds job and report search limits to 50", () => {
  assert.throws(() => collectorJobSchema.parse({ ...job, searchLimit: 51 }));
  assert.throws(() => collectorReportSchema.parse({ ...report, searchLimit: 51 }));
});

test("keeps collector jobs compatible with catalog text stored before report bounds", () => {
  const longUrl = `https://detail.tmall.com/item.htm?id=own-1&source=${"u".repeat(2_050)}`;
  const longTerm = "t".repeat(301);
  assert.doesNotThrow(() => collectorJobSchema.parse({
    ...job,
    ownListings: [{ ...job.ownListings[0], url: longUrl }],
    rule: {
      ...job.rule,
      mustIncludeTerms: [longTerm],
      excludedTerms: [longTerm]
    }
  }));
});

test("requires item search ranks to point to the same item in positions", () => {
  assert.throws(() => collectorReportSchema.parse({
    ...report,
    competitorItems: [{
      ...report.competitorItems[0],
      searchRanks: [3]
    }, report.competitorItems[1]]
  }));
});

test("requires each displayed price range to be ordered", () => {
  assert.throws(() => collectorReportSchema.parse({
    ...report,
    positions: report.positions.map((entry, index) => index === 0
      ? { ...entry, displayPriceMinFen: 70_000 }
      : entry)
  }));
});

test("bounds every persisted report scalar before the Prisma boundary", () => {
  const validReport = () => collectorReportSchema.parse(report);
  const rejectsAt = (
    mutate: (candidate: ReturnType<typeof validReport>) => void,
    expectedPath: Array<string | number>
  ) => {
    const candidate = validReport();
    mutate(candidate);
    const parsed = collectorReportSchema.safeParse(candidate);
    assert.equal(parsed.success, false);
    assert.ok(!parsed.success && parsed.error.issues.some((entry) =>
      JSON.stringify(entry.path) === JSON.stringify(expectedPath)), JSON.stringify(expectedPath));
  };

  rejectsAt((candidate) => { candidate.runId = "r".repeat(161); }, ["runId"]);
  rejectsAt((candidate) => { candidate.collectorId = "c".repeat(161); }, ["collectorId"]);
  rejectsAt((candidate) => { candidate.appVersion = "v".repeat(121); }, ["appVersion"]);
  rejectsAt((candidate) => {
    candidate.positions[2]!.platformItemId = "i".repeat(161);
  }, ["positions", 2, "platformItemId"]);
  rejectsAt((candidate) => { candidate.positions[0]!.shopName = "s".repeat(201); }, ["positions", 0, "shopName"]);
  rejectsAt((candidate) => { candidate.positions[0]!.title = "t".repeat(1001); }, ["positions", 0, "title"]);
  rejectsAt((candidate) => { candidate.positions[0]!.url = `https://example.com/${"u".repeat(2050)}`; }, ["positions", 0, "url"]);
  rejectsAt((candidate) => { candidate.ownItems[0]!.ownListingId = "o".repeat(161); }, ["ownItems", 0, "ownListingId"]);
  rejectsAt((candidate) => { candidate.ownItems[0]!.skus[0]!.skuId = "k".repeat(161); }, ["ownItems", 0, "skus", 0, "skuId"]);
  rejectsAt((candidate) => { candidate.ownItems[0]!.skus[0]!.label = "l".repeat(501); }, ["ownItems", 0, "skus", 0, "label"]);
  rejectsAt((candidate) => {
    candidate.ownItems[0]!.skus[0]!.listPriceFen = 2_147_483_648;
  }, ["ownItems", 0, "skus", 0, "listPriceFen"]);
  rejectsAt((candidate) => {
    candidate.positions[0]!.displayPriceMinFen = 2_147_483_648;
  }, ["positions", 0, "displayPriceMinFen"]);
  rejectsAt((candidate) => {
    candidate.ownItems[0]!.skus[0]!.promotions[0]!.amountFen = 2_147_483_648;
  }, ["ownItems", 0, "skus", 0, "promotions", 0, "amountFen"]);
});
