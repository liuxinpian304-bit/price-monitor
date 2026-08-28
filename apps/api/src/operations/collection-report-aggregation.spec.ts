import assert from "node:assert/strict";
import test from "node:test";

import {
  aggregateCollectionRunReport,
  type CollectionRunBusinessAggregationInput,
  type CollectionRunBusinessSnapshotFact
} from "./collection-report-aggregation.ts";

const capturedAt = new Date("2026-08-28T01:30:00.000Z");
const coreComponent = {
  role: "CORE" as const,
  accessoryType: "HEADPHONES",
  brand: "Sony",
  modelOrName: "MDR-7506",
  quantity: 1
};

function snapshot(
  id: string,
  overrides: Partial<CollectionRunBusinessSnapshotFact> = {}
): CollectionRunBusinessSnapshotFact {
  return {
    id,
    ownListingId: null,
    platformItemId: "item-a",
    skuId: id,
    shopName: "Alpha Shop",
    title: "Sony MDR-7506",
    skuText: "MDR-7506 single",
    url: `https://example.invalid/items/${id}`,
    attributes: { color: "Black" },
    components: [coreComponent],
    promotions: [],
    gifts: [],
    listPriceFen: 148_000,
    activityPriceFen: 148_000,
    couponDiscountFen: 0,
    fullReductionFen: 0,
    directDiscountFen: 0,
    mandatoryFeeFen: 0,
    publicDiscountFen: 0,
    payableFen: 148_000,
    priceConfidence: "CONFIRMED",
    stockState: "IN_STOCK",
    matchCategory: "EXACT",
    matchDecision: "BARE",
    comparable: true,
    matchConfidenceBps: 10_000,
    matchReasons: ["MODEL_EXACT"],
    combinationSignature: "signature-single",
    combinationLabel: "MDR-7506 single",
    combinationState: "MATCHED",
    combinationReasons: ["EXACT_SIGNATURE"],
    comparisonOwnSnapshotId: "own-low",
    evidenceKey: null,
    capturedAt,
    ...overrides
  };
}

function reportFixture(): CollectionRunBusinessAggregationInput {
  return {
    claimedOwnListingIds: ["listing-low", "listing-alt"],
    positions: [
      {
        rank: 7,
        platformItemId: "item-b",
        url: "https://example.invalid/items/item-b",
        shopName: "ALPHA SHOP",
        title: "Sony MDR-7506 second item",
        displayPriceMinFen: 148_100,
        displayPriceMaxFen: 148_100,
        sponsored: false,
        capturedAt
      },
      {
        rank: 4,
        platformItemId: "item-a",
        url: "https://example.invalid/items/item-a",
        shopName: "alpha   shop",
        title: "Sony MDR-7506 duplicate position",
        displayPriceMinFen: 1,
        displayPriceMaxFen: 1,
        sponsored: true,
        capturedAt
      },
      {
        rank: 1,
        platformItemId: "item-a",
        url: "https://example.invalid/items/item-a",
        shopName: " Alpha Shop ",
        title: "Sony MDR-7506",
        displayPriceMinFen: 1,
        displayPriceMaxFen: 1,
        sponsored: false,
        capturedAt
      },
      {
        rank: 2,
        platformItemId: "item-c",
        url: "https://example.invalid/items/item-c",
        shopName: "Beta Shop",
        title: "Sony bundle A",
        displayPriceMinFen: 10,
        displayPriceMaxFen: 10,
        sponsored: false,
        capturedAt
      },
      {
        rank: 3,
        platformItemId: "item-d",
        url: "https://example.invalid/items/item-d",
        shopName: "Gamma Shop",
        title: "Sony bundle B",
        displayPriceMinFen: 20,
        displayPriceMaxFen: 20,
        sponsored: false,
        capturedAt
      }
    ],
    snapshots: [
      snapshot("own-alt", {
        ownListingId: "listing-alt",
        platformItemId: "own-alt-item",
        skuId: "own-alt-sku",
        shopName: "Own Shop",
        url: "https://example.invalid/own/alt",
        payableFen: 148_100,
        combinationState: "OWN",
        comparisonOwnSnapshotId: null
      }),
      snapshot("own-low", {
        ownListingId: "listing-low",
        platformItemId: "own-low-item",
        skuId: "own-low-sku",
        shopName: "Own Shop",
        url: "https://example.invalid/own/low",
        combinationState: "OWN",
        comparisonOwnSnapshotId: null
      }),
      snapshot("competitor-low", {
        platformItemId: "item-a",
        payableFen: 147_999,
        listPriceFen: 149_000,
        activityPriceFen: 148_999,
        couponDiscountFen: 1_000,
        promotions: [{
          kind: "COUPON",
          label: "Public coupon",
          amountFen: 1_000,
          thresholdFen: 100_000,
          audience: "PUBLIC",
          stackGroup: "shop-coupon",
          includedInActivityPrice: false,
          activityPriceInclusion: "EXCLUDED"
        }]
      }),
      snapshot("competitor-higher", {
        platformItemId: "item-b",
        payableFen: 148_100
      }),
      snapshot("missing-beta", {
        platformItemId: "item-c",
        shopName: "Beta Shop",
        skuText: "MDR-7506 with stand",
        payableFen: 188_000,
        combinationSignature: "signature-stand",
        combinationLabel: "MDR-7506 + stand",
        combinationState: "MISSING_OWN",
        combinationReasons: ["OWN_COMBINATION_ABSENT"],
        comparisonOwnSnapshotId: null
      }),
      snapshot("missing-gamma", {
        platformItemId: "item-d",
        shopName: "Gamma Shop",
        skuText: "MDR-7506 with stand",
        payableFen: 189_000,
        combinationSignature: "signature-stand",
        combinationLabel: "MDR-7506 + stand",
        combinationState: "MISSING_OWN",
        combinationReasons: ["OWN_COMBINATION_ABSENT"],
        comparisonOwnSnapshotId: null
      })
    ]
  };
}

test("groups complete displayed positions by normalized shop and preserves detail facts", () => {
  const result = aggregateCollectionRunReport(reportFixture());

  assert.deepEqual(result.priceBoard.shops.map((shop) => shop.shopName), [
    "Alpha Shop",
    "Beta Shop",
    "Gamma Shop"
  ]);
  assert.deepEqual(result.priceBoard.shops[0]?.ranks, [1, 4, 7]);
  assert.equal(result.priceBoard.shops[0]?.positionCount, 3);
  assert.equal(result.priceBoard.shops[0]?.itemCount, 2);
  assert.equal(result.confirmedLows.length, 1);
  assert.equal(result.confirmedLows[0]?.selectedOwnSnapshot.id, "own-low");
  assert.deepEqual(result.confirmedLows[0]?.alternativeOwnSnapshots.map((row) => row.id), ["own-alt"]);
  assert.deepEqual(result.confirmedLows[0]?.ranks, [1, 4]);
  assert.equal(result.confirmedLows[0]?.differenceFen, 1);
  assert.equal(result.confirmedLows[0]?.competitorSnapshot.url, "https://example.invalid/items/competitor-low");
  assert.equal(result.confirmedLows[0]?.competitorSnapshot.prices.payableFen, 147_999);
  assert.equal(result.confirmedLows[0]?.competitorSnapshot.prices.couponDiscountFen, 1_000);
  assert.equal(result.confirmedLows[0]?.competitorSnapshot.promotions[0]?.kind, "COUPON");
  assert.deepEqual(result.confirmedLows[0]?.competitorSnapshot.components, [coreComponent]);
  assert.equal(result.missingOwnGroups.length, 1);
  assert.deepEqual(result.missingOwnGroups[0]?.shops, ["Beta Shop", "Gamma Shop"]);
  assert.equal(result.missingOwnGroups[0]?.minimumConfirmedPayableFen, 188_000);
  assert.deepEqual(result.missingOwnGroups[0]?.offers.map((row) => row.id), ["missing-beta", "missing-gamma"]);
});

test("orders confirmed lows by signed difference descending then earliest rank", () => {
  const input = reportFixture();
  input.positions.push(
    { ...input.positions[0]!, rank: 5, platformItemId: "item-e", shopName: "Delta Shop" },
    { ...input.positions[0]!, rank: 6, platformItemId: "item-f", shopName: "Epsilon Shop" }
  );
  input.snapshots.push(
    snapshot("low-rank-five", { platformItemId: "item-e", payableFen: 147_900 }),
    snapshot("low-rank-six", { platformItemId: "item-f", payableFen: 147_900 })
  );

  const forward = aggregateCollectionRunReport(input);
  const reverse = aggregateCollectionRunReport({
    ...input,
    positions: [...input.positions].reverse(),
    snapshots: [...input.snapshots].reverse()
  });

  assert.deepEqual(
    forward.confirmedLows.map((row) => row.competitorSnapshot.id),
    ["low-rank-five", "low-rank-six", "competitor-low"]
  );
  assert.deepEqual(reverse, forward);
});

test("downgrades historical null combination states without inventing business outcomes", () => {
  const input = reportFixture();
  input.snapshots = input.snapshots.map((row) => ({
    ...row,
    combinationState: null,
    combinationSignature: null,
    combinationLabel: null,
    combinationReasons: [],
    comparisonOwnSnapshotId: null
  }));

  const result = aggregateCollectionRunReport(input);

  assert.equal(result.confirmedLows.length, 0);
  assert.equal(result.missingOwnGroups.length, 0);
  assert.equal(result.reviewRows.length, 4);
  assert.ok(result.reviewRows.every((row) => row.combination.state === "REVIEW"));
  assert.ok(result.reviewRows.every((row) =>
    row.combination.reasons.includes("LEGACY_COMBINATION_NOT_EVALUATED")));
});
