import assert from "node:assert/strict";
import test from "node:test";

import { migrateLegacyCheckpointReport } from "./legacy-checkpoint-price-migration.ts";

const capturedAt = "2026-08-24T05:00:00.000Z";

function reportWithCoupon(activityPriceInclusion?: "EXCLUDED"): Record<string, unknown> {
  return {
    schemaVersion: 1,
    runId: "run-1",
    collectorId: "collector-1",
    appVersion: "fixture-1.0",
    startedAt: capturedAt,
    completedAt: capturedAt,
    status: "FAILED",
    searchLimit: 3,
    positions: [{
      rank: 1,
      platformItemId: "1001",
      url: "https://item.example.test/item.htm?id=1001",
      shopName: "Own Shop",
      title: "Sony MDR-7506",
      displayPriceMinFen: 6_500,
      displayPriceMaxFen: 8_000,
      sponsored: false,
      capturedAt
    }],
    ownItems: [{
      ownListingId: "own-1",
      platformItemId: "1001",
      url: "https://item.example.test/item.htm?id=1001",
      shopName: "Own Shop",
      title: "Sony MDR-7506",
      searchRanks: [1],
      skus: [{
        skuId: `sku_${"a".repeat(64)}`,
        label: "Black",
        attributes: { color: "Black" },
        stockState: "IN_STOCK",
        listPriceFen: 10_000,
        activityPriceFen: 8_000,
        couponDiscountFen: 1_000,
        fullReductionFen: 200,
        directDiscountFen: 300,
        promotions: [{
          kind: "COUPON",
          label: "Public coupon",
          amountFen: 1_000,
          thresholdFen: 5_000,
          audience: "PUBLIC",
          stackGroup: "coupon",
          includedInActivityPrice: false,
          ...(activityPriceInclusion === undefined ? {} : { activityPriceInclusion })
        }],
        mandatoryFeeFen: 0,
        priceConfidence: "CONFIRMED",
        payableFen: 6_500,
        capturedAt,
        evidenceKey: `sha256:${"e".repeat(64)}`
      }]
    }],
    competitorItems: [],
    issues: []
  };
}

test("downgrades a legacy false inclusion price without mutating collection evidence", () => {
  const legacyReport = reportWithCoupon();
  const original = structuredClone(legacyReport);

  const migrated = migrateLegacyCheckpointReport(legacyReport) as any;
  const sku = migrated.ownItems[0].skus[0];

  assert.equal(sku.promotions[0].activityPriceInclusion, "UNKNOWN");
  assert.equal(sku.couponDiscountFen, 0);
  assert.equal(sku.fullReductionFen, 0);
  assert.equal(sku.directDiscountFen, 0);
  assert.equal(sku.payableFen, null);
  assert.equal(sku.priceConfidence, "MANUAL_REVIEW");
  assert.deepEqual(migrated.ownItems[0].searchRanks, [1]);
  assert.equal(sku.evidenceKey, `sha256:${"e".repeat(64)}`);
  assert.deepEqual(legacyReport, original);
  assert.deepEqual(migrateLegacyCheckpointReport(migrated), migrated);
});

test("leaves explicit EXCLUDED confirmed price components unchanged", () => {
  const legacyReport = reportWithCoupon("EXCLUDED");
  const originalSku = (legacyReport.ownItems as any[])[0].skus[0];

  const migrated = migrateLegacyCheckpointReport(legacyReport) as any;
  const sku = migrated.ownItems[0].skus[0];

  assert.equal(sku.promotions[0].activityPriceInclusion, "EXCLUDED");
  assert.equal(sku.couponDiscountFen, originalSku.couponDiscountFen);
  assert.equal(sku.fullReductionFen, originalSku.fullReductionFen);
  assert.equal(sku.directDiscountFen, originalSku.directDiscountFen);
  assert.equal(sku.payableFen, originalSku.payableFen);
  assert.equal(sku.priceConfidence, "CONFIRMED");
});

test("does not replace malformed price fields while normalizing legacy promotion inclusion", () => {
  const legacyReport = reportWithCoupon();
  const originalSku = (legacyReport.ownItems as any[])[0].skus[0];
  originalSku.couponDiscountFen = "not-fen";

  const migrated = migrateLegacyCheckpointReport(legacyReport) as any;
  const sku = migrated.ownItems[0].skus[0];

  assert.equal(sku.promotions[0].activityPriceInclusion, "UNKNOWN");
  assert.equal(sku.couponDiscountFen, "not-fen");
  assert.equal(sku.priceConfidence, "CONFIRMED");
  assert.equal(sku.payableFen, 6_500);
});
