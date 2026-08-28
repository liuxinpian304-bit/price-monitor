import assert from "node:assert/strict";
import test from "node:test";

import {
  aggregateCollectionRunReport,
  projectCollectionRunBusinessSkuRows,
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
  assert.equal(result.missingOwnGroups[0]?.minimumOfferSnapshotId, "missing-beta");
  assert.equal(result.missingOwnGroups[0]?.minimumOfferRank, 2);
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

test("requires complete confirmed in-stock persisted facts for confirmed lows", () => {
  const cases: Array<[
    string,
    (competitor: CollectionRunBusinessSnapshotFact, own: CollectionRunBusinessSnapshotFact) => void
  ]> = [
    ["competitor confidence", (competitor) => { competitor.priceConfidence = "ESTIMATED"; }],
    ["competitor null price", (competitor) => { competitor.payableFen = null; }],
    ["competitor negative price", (competitor) => { competitor.payableFen = -1; }],
    ["competitor stock", (competitor) => { competitor.stockState = "OUT_OF_STOCK"; }],
    ["own confidence", (_competitor, own) => { own.priceConfidence = "MANUAL_REVIEW"; }],
    ["own null price", (_competitor, own) => { own.payableFen = null; }],
    ["own negative price", (_competitor, own) => { own.payableFen = -1; }],
    ["own stock", (_competitor, own) => { own.stockState = "UNKNOWN"; }],
    ["persisted state", (competitor) => { competitor.combinationState = "REVIEW"; }]
  ];

  for (const [label, mutate] of cases) {
    const input = reportFixture();
    const competitor = input.snapshots.find((row) => row.id === "competitor-low")!;
    const own = input.snapshots.find((row) => row.id === "own-low")!;
    mutate(competitor, own);

    assert.equal(
      aggregateCollectionRunReport(input).confirmedLows.some((row) =>
        row.competitorSnapshot.id === competitor.id),
      false,
      label
    );
  }
});

test("keeps signed business differences while nested comparisons remain absolute", () => {
  const input = reportFixture();
  input.positions.push({
    ...input.positions[0]!,
    rank: 5,
    platformItemId: "item-e",
    shopName: "Delta Shop"
  });
  input.snapshots.push(snapshot("competitor-equal", {
    platformItemId: "item-e",
    payableFen: 148_000
  }));

  const byId = new Map(projectCollectionRunBusinessSkuRows(input).map((row) => [row.id, row]));
  assert.deepEqual(
    ["competitor-low", "competitor-equal", "competitor-higher"].map((id) => ({
      id,
      state: byId.get(id)?.comparison.state,
      signed: byId.get(id)?.differenceFen,
      compatibility: byId.get(id)?.comparison.differenceFen
    })),
    [
      { id: "competitor-low", state: "LOWER", signed: 1, compatibility: 1 },
      { id: "competitor-equal", state: "NOT_LOWER", signed: 0, compatibility: 0 },
      { id: "competitor-higher", state: "NOT_LOWER", signed: -100, compatibility: 100 }
    ]
  );
});

test("downgrades corrupt selected-own relations and never exposes selected-own facts", () => {
  const cases: Array<[string, (input: CollectionRunBusinessAggregationInput) => void]> = [
    ["cross signature own", (input) => {
      const competitor = input.snapshots.find((row) => row.id === "competitor-low")!;
      const own = input.snapshots.find((row) => row.id === "own-alt")!;
      own.combinationSignature = "different-signature";
      competitor.comparisonOwnSnapshotId = own.id;
    }],
    ["non-own snapshot", (input) => {
      const competitor = input.snapshots.find((row) => row.id === "competitor-low")!;
      competitor.comparisonOwnSnapshotId = "competitor-higher";
    }]
  ];

  for (const [label, corrupt] of cases) {
    const input = reportFixture();
    corrupt(input);
    const result = aggregateCollectionRunReport(input);
    const row = projectCollectionRunBusinessSkuRows(input)
      .find((candidate) => candidate.id === "competitor-low");

    assert.equal(result.confirmedLows.some((low) => low.competitorSnapshot.id === row?.id), false, label);
    assert.equal(row?.selectedOwnSnapshot, null, label);
    assert.equal(row?.combination.state, "REVIEW", label);
    assert.ok(row?.combination.reasons.includes("INVALID_COMPARISON_OWN_SNAPSHOT"), label);
  }
});

test("preserves missing-own groups with no confirmed eligible offer", () => {
  const input = reportFixture();
  const beta = input.snapshots.find((row) => row.id === "missing-beta")!;
  const gamma = input.snapshots.find((row) => row.id === "missing-gamma")!;
  beta.priceConfidence = "ESTIMATED";
  gamma.payableFen = null;

  const group = aggregateCollectionRunReport(input).missingOwnGroups[0];

  assert.ok(group);
  assert.equal(group.minimumConfirmedPayableFen, null);
  assert.equal(group.minimumOfferSnapshotId, null);
  assert.equal(group.minimumOfferRank, null);
  assert.deepEqual(group.shops, ["Beta Shop", "Gamma Shop"]);
  assert.deepEqual(group.offers.map((row) => row.id), ["missing-beta", "missing-gamma"]);
  assert.deepEqual(group.offers.map((row) => row.url), [
    "https://example.invalid/items/missing-beta",
    "https://example.invalid/items/missing-gamma"
  ]);
});

test("selects missing-own minimum price and rank from one deterministic source offer", () => {
  const input = reportFixture();
  const beta = input.snapshots.find((row) => row.id === "missing-beta")!;
  const gamma = input.snapshots.find((row) => row.id === "missing-gamma")!;
  beta.payableFen = 190_000;
  gamma.payableFen = 188_000;

  let group = aggregateCollectionRunReport(input).missingOwnGroups[0];
  assert.equal(group?.minimumConfirmedPayableFen, 188_000);
  assert.equal(group?.minimumOfferSnapshotId, "missing-gamma");
  assert.equal(group?.minimumOfferRank, 3);

  beta.payableFen = 188_000;
  const reversed = aggregateCollectionRunReport({
    ...input,
    positions: [...input.positions].reverse(),
    snapshots: [...input.snapshots].reverse()
  });
  group = reversed.missingOwnGroups[0];
  assert.equal(group?.minimumConfirmedPayableFen, 188_000);
  assert.equal(group?.minimumOfferSnapshotId, "missing-beta");
  assert.equal(group?.minimumOfferRank, 2);
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
