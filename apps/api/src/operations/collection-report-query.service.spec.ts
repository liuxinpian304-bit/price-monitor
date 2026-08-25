import assert from "node:assert/strict";
import test from "node:test";

import {
  CollectionReportQueryService,
  type CollectionReportDataRepository,
  type CollectionReportRawRun
} from "./collection-report-query.service.ts";

const capturedAt = new Date("2026-08-25T01:30:00.000Z");

function runFixture(): CollectionReportRawRun {
  return {
    id: "run-7506",
    status: "PARTIAL_FAILED",
    providerKey: "taobao-desktop",
    scheduledFor: capturedAt,
    startedAt: capturedAt,
    finishedAt: new Date("2026-08-25T01:38:00.000Z"),
    searchLimit: 50,
    searchedCount: 47,
    fetchedCount: 47,
    matchedCount: 2,
    failedCount: 3,
    discoveredCount: 47,
    skuCount: 5,
    incompleteCount: 3,
    errorCode: "SKU_ENUMERATION_INCOMPLETE",
    errorMessage: "3 个 SKU 未完成采集",
    monitoredModel: {
      id: "model-7506",
      monitorCode: "SONY-7506",
      brand: "Sony",
      standardModel: "MDR-7506",
      comparisonType: "BARE",
      owner: "运营A"
    },
    collectorAgent: {
      id: "agent-mac-1",
      name: "mac-studio-1",
      platform: "MACOS",
      appVersion: "2.4.5"
    },
    alertNotificationBatch: {
      state: "PENDING",
      notificationAttempts: 1,
      notifiedAt: null,
      lastNotificationError: "WECOM_NOT_CONFIGURED"
    },
    positions: [
      {
        rank: 1,
        platformItemId: "own-7506",
        url: "https://detail.tmall.com/item.htm?id=own-7506",
        shopName: "星空乐器专营店",
        title: "Sony MDR-7506",
        displayPriceMinFen: 69_800,
        displayPriceMaxFen: 69_800,
        sponsored: false,
        capturedAt
      },
      {
        rank: 2,
        platformItemId: "competitor-7506",
        url: "https://item.taobao.com/item.htm?id=competitor-7506",
        shopName: "同行音频店",
        title: "Sony MDR-7506",
        displayPriceMinFen: 65_800,
        displayPriceMaxFen: 69_799,
        sponsored: false,
        capturedAt
      }
    ],
    snapshots: [
      {
        id: "own-sku",
        ownListingId: "own-listing-7506",
        searchCandidateId: null,
        platformItemId: "own-7506",
        skuId: "own-standard",
        shopName: "星空乐器专营店",
        title: "Sony MDR-7506",
        skuText: "标准版",
        ownListingSkuText: "标准版",
        url: "https://detail.tmall.com/item.htm?id=own-7506",
        listPriceFen: 69_800,
        activityPriceFen: 69_800,
        couponDiscountFen: 0,
        fullReductionFen: 0,
        directDiscountFen: 0,
        mandatoryFeeFen: 0,
        publicDiscountFen: 0,
        payableFen: 69_800,
        priceConfidence: "CONFIRMED",
        stockState: "IN_STOCK",
        matchDecision: "BARE",
        comparable: true,
        matchConfidenceBps: 10_000,
        matchReasons: ["型号一致"],
        evidenceKey: `sha256:${"a".repeat(64)}`,
        capturedAt
      },
      {
        id: "lower-sku",
        ownListingId: null,
        searchCandidateId: "candidate-7506",
        platformItemId: "competitor-7506",
        skuId: "competitor-standard",
        shopName: "同行音频店",
        title: "Sony MDR-7506",
        skuText: "标准版",
        ownListingSkuText: null,
        url: "https://item.taobao.com/item.htm?id=competitor-7506",
        listPriceFen: 69_799,
        activityPriceFen: 69_799,
        couponDiscountFen: 0,
        fullReductionFen: 0,
        directDiscountFen: 0,
        mandatoryFeeFen: 0,
        publicDiscountFen: 0,
        payableFen: 69_799,
        priceConfidence: "CONFIRMED",
        stockState: "IN_STOCK",
        matchDecision: "BARE",
        comparable: true,
        matchConfidenceBps: 10_000,
        matchReasons: ["型号一致"],
        evidenceKey: `sha256:${"b".repeat(64)}`,
        capturedAt
      },
      {
        id: "review-sku",
        ownListingId: null,
        searchCandidateId: "candidate-7506",
        platformItemId: "competitor-7506",
        skuId: "competitor-m1",
        shopName: "同行音频店",
        title: "Sony MDR-M1",
        skuText: "M1",
        ownListingSkuText: null,
        url: "https://item.taobao.com/item.htm?id=competitor-7506",
        listPriceFen: 40_000,
        activityPriceFen: 40_000,
        couponDiscountFen: 0,
        fullReductionFen: 0,
        directDiscountFen: 0,
        mandatoryFeeFen: 0,
        publicDiscountFen: 0,
        payableFen: 40_000,
        priceConfidence: "MANUAL_REVIEW",
        stockState: "IN_STOCK",
        matchDecision: "MANUAL",
        comparable: false,
        matchConfidenceBps: 5_000,
        matchReasons: ["版本不确定"],
        evidenceKey: null,
        capturedAt
      },
      {
        id: "not-lower-sku",
        ownListingId: null,
        searchCandidateId: "candidate-7506",
        platformItemId: "competitor-7506",
        skuId: "competitor-higher",
        shopName: "同行音频店",
        title: "Sony MDR-7506",
        skuText: "标准版",
        ownListingSkuText: null,
        url: "https://item.taobao.com/item.htm?id=competitor-7506",
        listPriceFen: 70_000,
        activityPriceFen: 70_000,
        couponDiscountFen: 0,
        fullReductionFen: 0,
        directDiscountFen: 0,
        mandatoryFeeFen: 0,
        publicDiscountFen: 0,
        payableFen: 70_000,
        priceConfidence: "CONFIRMED",
        stockState: "IN_STOCK",
        matchDecision: "BARE",
        comparable: true,
        matchConfidenceBps: 10_000,
        matchReasons: ["型号一致"],
        evidenceKey: null,
        capturedAt
      },
      {
        id: "excluded-sku",
        ownListingId: null,
        searchCandidateId: "candidate-7506",
        platformItemId: "competitor-7506",
        skuId: "competitor-used",
        shopName: "同行音频店",
        title: "Sony MDR-7506 二手",
        skuText: "二手",
        ownListingSkuText: null,
        url: "https://item.taobao.com/item.htm?id=competitor-7506",
        listPriceFen: 50_000,
        activityPriceFen: 50_000,
        couponDiscountFen: 0,
        fullReductionFen: 0,
        directDiscountFen: 0,
        mandatoryFeeFen: 0,
        publicDiscountFen: 0,
        payableFen: 50_000,
        priceConfidence: "CONFIRMED",
        stockState: "OUT_OF_STOCK",
        matchDecision: "REJECTED",
        comparable: false,
        matchConfidenceBps: 0,
        matchReasons: ["排除二手"],
        evidenceKey: null,
        capturedAt
      }
    ],
    issues: [
      {
        id: "issue-1",
        code: "SKU_ENUMERATION_INCOMPLETE",
        platformItemId: "competitor-7506",
        skuId: "competitor-m1",
        message: "SKU 选择不稳定",
        evidenceKey: `sha256:${"c".repeat(64)}`,
        capturedAt
      }
    ]
  };
}

function repository(run = runFixture()): CollectionReportDataRepository {
  return {
    listRuns: async () => [run],
    findRun: async (runId) => runId === run.id ? run : null,
    isEvidenceReferenced: async (runId, evidenceKey) => runId === run.id
      && [
        ...run.snapshots.map((snapshot) => snapshot.evidenceKey),
        ...run.issues.map((issue) => issue.evidenceKey)
      ].includes(evidenceKey)
  };
}

test("lists collection runs with completion and notification facts", async () => {
  const service = new CollectionReportQueryService(repository());

  const result = await service.listRuns();

  assert.equal(result.runs.length, 1);
  assert.equal(result.runs[0]?.completion.positionsCaptured, 2);
  assert.equal(result.runs[0]?.completion.requestedPositions, 50);
  assert.equal(result.runs[0]?.completion.uniqueItemCount, 2);
  assert.equal(result.runs[0]?.completion.skuCount, 5);
  assert.equal(result.runs[0]?.completion.incompleteCount, 3);
  assert.equal(result.runs[0]?.completion.discoveredCount, 47);
  assert.equal(result.runs[0]?.completion.fetchedCount, 47);
  assert.equal(result.runs[0]?.completion.matchedCount, 2);
  assert.equal(result.runs[0]?.completion.failedCount, 3);
  assert.equal(result.runs[0]?.completion.complete, false);
  assert.equal(result.runs[0]?.notification.state, "PENDING");
  assert.equal(result.runs[0]?.model.monitorCode, "SONY-7506");
});

test("does not present legacy aggregate progress as captured rank evidence", async () => {
  const run = runFixture();
  run.searchedCount = 50;
  run.incompleteCount = 0;
  run.positions = [];
  const service = new CollectionReportQueryService(repository(run));

  const result = await service.listRuns();

  assert.equal(result.runs[0]?.completion.positionsCaptured, 0);
  assert.equal(result.runs[0]?.completion.complete, false);
  assert.equal(result.runs[0]?.completion.label, "0 / 50，未完成");
});

test("returns independent SKU records and only treats confirmed exact stock as lower", async () => {
  const service = new CollectionReportQueryService(repository());

  const result = await service.getRun("run-7506", {
    source: "COMPETITOR",
    match: "EXACT",
    price: "LOWER",
    confidence: "CONFIRMED"
  });

  assert.ok(result);
  assert.equal(result.skus.length, 1);
  assert.equal(result.skus[0]?.id, "lower-sku");
  assert.equal(result.skus[0]?.comparison.state, "LOWER");
  assert.equal(result.skus[0]?.comparison.differenceFen, 1);
  assert.equal(result.skus[0]?.evidenceSha256, "b".repeat(64));
  assert.equal(result.completion.complete, false);
  assert.equal(result.completion.label, "2 / 50，未完成");
});

test("supports every report filter value without collapsing independent SKU rows", async () => {
  const service = new CollectionReportQueryService(repository());

  assert.deepEqual(
    (await service.getRun("run-7506", { source: "OWN", match: "EXACT", confidence: "CONFIRMED" }))?.skus.map((row) => row.id),
    ["own-sku"]
  );
  assert.deepEqual(
    (await service.getRun("run-7506", { source: "COMPETITOR", match: "REVIEW", confidence: "MANUAL_REVIEW" }))?.skus.map((row) => row.id),
    ["review-sku"]
  );
  assert.deepEqual(
    (await service.getRun("run-7506", { source: "COMPETITOR", match: "EXCLUDED" }))?.skus.map((row) => row.id),
    ["excluded-sku"]
  );
  assert.deepEqual(
    (await service.getRun("run-7506", { source: "COMPETITOR", price: "NOT_LOWER", confidence: "CONFIRMED" }))?.skus.map((row) => row.id),
    ["not-lower-sku"]
  );
});

test("checks an evidence hash against the run before storage access", async () => {
  const service = new CollectionReportQueryService(repository());

  assert.equal(await service.isEvidenceReferenced("run-7506", "b".repeat(64)), true);
  assert.equal(await service.isEvidenceReferenced("run-7506", "d".repeat(64)), false);
  assert.equal(await service.isEvidenceReferenced("other-run", "b".repeat(64)), false);
});
