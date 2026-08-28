import assert from "node:assert/strict";
import test from "node:test";

import type { SkuCombinationBuildResult } from "../pricing/sku-combination.ts";
import {
  evaluateRunSkuCombinations,
  type RunSkuComparisonCandidate,
  type RunSkuComparisonInput
} from "./run-sku-comparison.ts";

const SINGLE_SIGNATURE = `sku-combination-v1:${"a".repeat(64)}`;
const BUNDLE_SIGNATURE = `sku-combination-v1:${"b".repeat(64)}`;
const THIRD_SIGNATURE = `sku-combination-v1:${"c".repeat(64)}`;
const FOURTH_SIGNATURE = `sku-combination-v1:${"d".repeat(64)}`;

function signed(
  signature = SINGLE_SIGNATURE,
  label = "RODE NT1S 新品 核心麦克风nt1sx1"
): Extract<SkuCombinationBuildResult, { kind: "SIGNED" }> {
  return {
    kind: "SIGNED",
    signature,
    label,
    canonical: {
      version: "sku-combination-v1",
      brand: "rode",
      model: "nt1s",
      condition: "new",
      core: [{ model: "nt1s", quantity: 1 }],
      paidAccessories: [],
      materialAttributes: {},
      color: null
    },
    reasons: []
  };
}

function candidate(
  snapshotId: string,
  payableFen: number | null,
  overrides: Partial<RunSkuComparisonCandidate> = {}
): RunSkuComparisonCandidate {
  return {
    snapshotId,
    source: "COMPETITOR",
    platformItemId: `item-${snapshotId}`,
    skuId: `sku-${snapshotId}`,
    shopName: `shop-${snapshotId}`,
    searchRanks: [1],
    stockState: "IN_STOCK",
    priceConfidence: "CONFIRMED",
    payableFen,
    combination: signed(),
    ...overrides
  };
}

function own(
  snapshotId: string,
  payableFen: number | null,
  overrides: Partial<RunSkuComparisonCandidate> = {}
): RunSkuComparisonCandidate {
  return candidate(snapshotId, payableFen, { source: "OWN", searchRanks: [], ...overrides });
}

function competitor(
  snapshotId: string,
  payableFen: number | null,
  overrides: Partial<RunSkuComparisonCandidate> = {}
): RunSkuComparisonCandidate {
  return candidate(snapshotId, payableFen, overrides);
}

function bundleCompetitor(
  snapshotId: string,
  payableFen: number,
  accessoryModel: string,
  overrides: Partial<RunSkuComparisonCandidate> = {}
): RunSkuComparisonCandidate {
  return competitor(snapshotId, payableFen, {
    combination: signed(BUNDLE_SIGNATURE, `RODE NT1S 新品 付费配件声卡${accessoryModel}x1`),
    ...overrides
  });
}

function runInput(input: {
  own?: RunSkuComparisonCandidate[];
  competitors?: RunSkuComparisonCandidate[];
  ownCatalogComplete?: boolean;
}): RunSkuComparisonInput {
  return {
    candidates: [...(input.own ?? []), ...(input.competitors ?? [])],
    ownCatalogComplete: input.ownCatalogComplete ?? true
  };
}

test("selects the lowest eligible own baseline per signature and retains every alternative", () => {
  const result = evaluateRunSkuCombinations(runInput({
    own: [
      own("own-high", 61_000),
      own("own-low", 60_000),
      own("own-oos", 59_000, { stockState: "OUT_OF_STOCK" })
    ],
    competitors: [competitor("competitor-1", 58_900)]
  }));

  assert.equal(result.bySnapshotId.get("competitor-1")?.state, "MATCHED");
  assert.equal(result.bySnapshotId.get("competitor-1")?.comparisonOwnSnapshotId, "own-low");
  assert.deepEqual(result.baselinesBySignature[0], {
    signature: SINGLE_SIGNATURE,
    label: "RODE NT1S 新品 核心麦克风nt1sx1",
    selectedSnapshotId: "own-low",
    selectedPayableFen: 60_000,
    alternativeSnapshotIds: ["own-high", "own-oos"]
  });
  assert.equal(result.bySnapshotId.get("own-low")?.state, "OWN");
  assert.equal(result.bySnapshotId.get("own-high")?.state, "OWN");
  assert.equal(result.bySnapshotId.get("own-oos")?.state, "REVIEW");
  assert.ok(result.bySnapshotId.get("own-oos")?.reasons.includes("OWN_OUT_OF_STOCK"));
  assert.equal(result.primaryOwnSnapshotId, "own-low");
});

test("creates an alert only when a matched competitor is at least one fen lower", () => {
  const duplicateRanks = [8, 2, 2];
  const result = evaluateRunSkuCombinations(runInput({
    own: [own("own", 60_000)],
    competitors: [
      competitor("one-fen-low", 59_999, { searchRanks: duplicateRanks }),
      competitor("equal", 60_000),
      competitor("higher", 60_001)
    ]
  }));

  assert.deepEqual(result.alertCandidates, [{
    snapshotId: "one-fen-low",
    comparisonOwnSnapshotId: "own",
    signature: SINGLE_SIGNATURE,
    label: "RODE NT1S 新品 核心麦克风nt1sx1",
    competitorPayableFen: 59_999,
    ownPayableFen: 60_000,
    differenceFen: 1,
    searchRanks: [8, 2, 2]
  }]);
  assert.deepEqual(duplicateRanks, [8, 2, 2]);
  assert.equal(result.bySnapshotId.get("equal")?.state, "MATCHED");
  assert.equal(result.bySnapshotId.get("higher")?.state, "MATCHED");
});

test("reviews a competitor when same-signature own pricing is unconfirmed", () => {
  const result = evaluateRunSkuCombinations(runInput({
    own: [own("own-estimated", 60_000, { priceConfidence: "ESTIMATED" })],
    competitors: [competitor("competitor", 50_000)]
  }));

  assert.equal(result.bySnapshotId.get("own-estimated")?.state, "REVIEW");
  assert.deepEqual(result.bySnapshotId.get("competitor")?.reasons, ["OWN_PRICE_UNCONFIRMED"]);
  assert.equal(result.bySnapshotId.get("competitor")?.state, "REVIEW");
  assert.equal(result.reviewCount, 2);
  assert.equal(result.alertCandidates.length, 0);
  assert.equal(result.missingOwnGroups.length, 0);
});

test("classifies only-out-of-stock same-signature own rows as missing rather than lower", () => {
  const result = evaluateRunSkuCombinations(runInput({
    own: [
      own("own-oos-2", 59_000, { stockState: "OUT_OF_STOCK" }),
      own("own-oos-1", 60_000, { stockState: "OUT_OF_STOCK" })
    ],
    competitors: [competitor("competitor", 50_000, { searchRanks: [9] })]
  }));

  assert.equal(result.bySnapshotId.get("competitor")?.state, "MISSING_OWN");
  assert.deepEqual(result.bySnapshotId.get("competitor")?.reasons, ["OWN_OUT_OF_STOCK_ONLY"]);
  assert.equal(result.bySnapshotId.get("competitor")?.comparisonOwnSnapshotId, null);
  assert.equal(result.missingOwnGroups[0]?.missingReason, "OWN_OUT_OF_STOCK_ONLY");
  assert.equal(result.alertCandidates.length, 0);
});

test("downgrades an absent signature to catalog-incomplete review", () => {
  const result = evaluateRunSkuCombinations(runInput({
    own: [own("single-mic", 148_000)],
    competitors: [bundleCompetitor("with-ai1", 188_000, "AI-1")],
    ownCatalogComplete: false
  }));

  assert.equal(result.bySnapshotId.get("with-ai1")?.state, "REVIEW");
  assert.deepEqual(result.bySnapshotId.get("with-ai1")?.reasons, ["OWN_CATALOG_INCOMPLETE"]);
  assert.equal(result.alertCandidates.length, 0);
  assert.equal(result.missingOwnGroups.length, 0);
});

test("classifies an absent signed combination as missing without creating an alert", () => {
  const missing = evaluateRunSkuCombinations(runInput({
    own: [own("single-mic", 148_000)],
    competitors: [bundleCompetitor("with-ai1", 188_000, "AI-1")]
  }));

  assert.equal(missing.bySnapshotId.get("with-ai1")?.state, "MISSING_OWN");
  assert.deepEqual(missing.bySnapshotId.get("with-ai1")?.reasons, ["OWN_COMBINATION_ABSENT"]);
  assert.equal(missing.missingOwnGroups.length, 1);
  assert.equal(missing.alertCandidates.length, 0);
});

test("retains canonical combination reasons when a later precedence step adds a state code", () => {
  const combination = signed(BUNDLE_SIGNATURE, "RODE NT1S 新品 AI-1 套装");
  combination.reasons = ["赠品或服务未计入组合签名"];
  const result = evaluateRunSkuCombinations(runInput({
    competitors: [competitor("missing-with-gift", 188_000, { combination })]
  }));

  assert.deepEqual(result.bySnapshotId.get("missing-with-gift")?.reasons, [
    "赠品或服务未计入组合签名",
    "OWN_COMBINATION_ABSENT"
  ]);
});

test("competitor price review outranks matching and missing-own classification", () => {
  const invalidPrices: Array<[string, number | null, RunSkuComparisonCandidate["priceConfidence"]]> = [
    ["estimated", 50_000, "ESTIMATED"],
    ["manual", 50_000, "MANUAL_REVIEW"],
    ["null", null, "CONFIRMED"],
    ["nan", Number.NaN, "CONFIRMED"],
    ["negative", -1, "CONFIRMED"]
  ];
  const competitors = invalidPrices.flatMap(([id, price, priceConfidence]) => [
    competitor(`${id}-matched`, price, { priceConfidence }),
    bundleCompetitor(`${id}-absent`, price ?? 0, "AI-1", { payableFen: price, priceConfidence })
  ]);
  const result = evaluateRunSkuCombinations(runInput({
    own: [own("own", 60_000)],
    competitors
  }));

  for (const row of competitors) {
    assert.equal(result.bySnapshotId.get(row.snapshotId)?.state, "REVIEW", row.snapshotId);
    assert.ok(
      result.bySnapshotId.get(row.snapshotId)?.reasons.includes("COMPETITOR_PRICE_UNCONFIRMED"),
      row.snapshotId
    );
  }
  assert.equal(result.alertCandidates.length, 0);
  assert.equal(result.missingOwnGroups.length, 0);
});

test("competitor unavailable stock outranks an eligible baseline", () => {
  const result = evaluateRunSkuCombinations(runInput({
    own: [own("own", 60_000)],
    competitors: [
      competitor("out", 50_000, { stockState: "OUT_OF_STOCK" }),
      competitor("unknown", 50_000, { stockState: "UNKNOWN" })
    ]
  }));

  assert.equal(result.bySnapshotId.get("out")?.state, "REVIEW");
  assert.deepEqual(result.bySnapshotId.get("out")?.reasons, ["COMPETITOR_OUT_OF_STOCK"]);
  assert.equal(result.bySnapshotId.get("unknown")?.state, "REVIEW");
  assert.deepEqual(result.bySnapshotId.get("unknown")?.reasons, ["COMPETITOR_STOCK_UNKNOWN"]);
  assert.equal(result.alertCandidates.length, 0);
});

test("combination EXCLUDED and REVIEW decisions outrank all stock price and own-index branches", () => {
  const excludedCombination: SkuCombinationBuildResult = {
    kind: "EXCLUDED",
    signature: null,
    label: null,
    reasons: ["NOT_TARGET_PRODUCT"]
  };
  const reviewCombination: SkuCombinationBuildResult = {
    kind: "REVIEW",
    signature: null,
    label: "待复核组合",
    reasons: ["UNKNOWN_COMPONENT"]
  };
  const result = evaluateRunSkuCombinations(runInput({
    own: [own("own", 60_000)],
    competitors: [
      competitor("excluded", -1, {
        stockState: "OUT_OF_STOCK",
        priceConfidence: "MANUAL_REVIEW",
        combination: excludedCombination
      }),
      competitor("review", -1, {
        stockState: "OUT_OF_STOCK",
        priceConfidence: "MANUAL_REVIEW",
        combination: reviewCombination
      })
    ]
  }));

  assert.deepEqual(result.bySnapshotId.get("excluded"), {
    snapshotId: "excluded",
    signature: null,
    label: null,
    state: "EXCLUDED",
    comparisonOwnSnapshotId: null,
    reasons: ["NOT_TARGET_PRODUCT"]
  });
  assert.deepEqual(result.bySnapshotId.get("review"), {
    snapshotId: "review",
    signature: null,
    label: "待复核组合",
    state: "REVIEW",
    comparisonOwnSnapshotId: null,
    reasons: ["UNKNOWN_COMPONENT"]
  });
});

test("an eligible own baseline outranks another same-signature unconfirmed own row", () => {
  const result = evaluateRunSkuCombinations(runInput({
    own: [
      own("own-confirmed", 60_000),
      own("own-estimated", 50_000, { priceConfidence: "ESTIMATED" })
    ],
    competitors: [competitor("competitor", 59_000)]
  }));

  assert.equal(result.bySnapshotId.get("competitor")?.state, "MATCHED");
  assert.equal(result.bySnapshotId.get("competitor")?.comparisonOwnSnapshotId, "own-confirmed");
  assert.deepEqual(result.baselinesBySignature[0]?.alternativeSnapshotIds, ["own-estimated"]);
  assert.equal(result.alertCandidates.length, 1);
});

test("same-signature unconfirmed own price outranks out-of-stock-only", () => {
  const result = evaluateRunSkuCombinations(runInput({
    own: [
      own("own-confirmed-oos", 60_000, { stockState: "OUT_OF_STOCK" }),
      own("own-estimated-oos", 50_000, {
        stockState: "OUT_OF_STOCK",
        priceConfidence: "ESTIMATED"
      })
    ],
    competitors: [competitor("competitor", 49_000)]
  }));

  assert.equal(result.bySnapshotId.get("competitor")?.state, "REVIEW");
  assert.deepEqual(result.bySnapshotId.get("competitor")?.reasons, ["OWN_PRICE_UNCONFIRMED"]);
  assert.equal(result.missingOwnGroups.length, 0);
});

test("reviews same-signature own rows with unknown availability", () => {
  const result = evaluateRunSkuCombinations(runInput({
    own: [own("own-unknown", 60_000, { stockState: "UNKNOWN" })],
    competitors: [competitor("competitor", 50_000)]
  }));

  assert.equal(result.bySnapshotId.get("competitor")?.state, "REVIEW");
  assert.deepEqual(result.bySnapshotId.get("competitor")?.reasons, ["OWN_STOCK_UNCONFIRMED"]);
  assert.equal(result.alertCandidates.length, 0);
});

test("defends baselines against null NaN infinite fractional and negative own prices", () => {
  const prices = [null, Number.NaN, Number.POSITIVE_INFINITY, 1.5, -1];

  for (const price of prices) {
    const result = evaluateRunSkuCombinations(runInput({
      own: [own(`own-${String(price)}`, price)],
      competitors: [competitor(`competitor-${String(price)}`, 1)]
    }));
    const competitorDecision = result.bySnapshotId.get(`competitor-${String(price)}`);
    assert.equal(competitorDecision?.state, "REVIEW", String(price));
    assert.deepEqual(competitorDecision?.reasons, ["OWN_PRICE_UNCONFIRMED"], String(price));
    assert.equal(result.baselinesBySignature.length, 0, String(price));
    assert.equal(result.primaryOwnSnapshotId, null, String(price));
    assert.equal(result.alertCandidates.length, 0, String(price));
  }
});

test("uses every deterministic own tie breaker and emits input-order-independent results", () => {
  const rows = [
    own("snap-z", 60_000, { platformItemId: "item-a", skuId: "sku-a" }),
    own("snap-a", 60_000, { platformItemId: "item-a", skuId: "sku-a" }),
    own("sku-b", 60_000, { platformItemId: "item-a", skuId: "sku-b" }),
    own("item-b", 60_000, { platformItemId: "item-b", skuId: "sku-a" }),
    own("global-low", 59_999, {
      platformItemId: "item-z",
      skuId: "sku-z",
      combination: signed(BUNDLE_SIGNATURE, "RODE NT1S 新品 AI-1 套装")
    })
  ];
  const competitors = [
    competitor("competitor-b", 50_000, { platformItemId: "competitor-item-b" }),
    competitor("competitor-a", 50_000, { platformItemId: "competitor-item-a" })
  ];

  const forward = evaluateRunSkuCombinations(runInput({ own: rows, competitors }));
  const reverse = evaluateRunSkuCombinations(runInput({
    own: [...rows].reverse(),
    competitors: [...competitors].reverse()
  }));

  assert.equal(forward.baselinesBySignature[0]?.selectedSnapshotId, "snap-a");
  assert.deepEqual(forward.baselinesBySignature[0]?.alternativeSnapshotIds, ["snap-z", "sku-b", "item-b"]);
  assert.equal(forward.primaryOwnSnapshotId, "global-low");
  assert.deepEqual([...forward.bySnapshotId.entries()], [...reverse.bySnapshotId.entries()]);
  assert.deepEqual(forward.baselinesBySignature, reverse.baselinesBySignature);
  assert.deepEqual(forward.alertCandidates, reverse.alertCandidates);
  assert.deepEqual(forward.missingOwnGroups, reverse.missingOwnGroups);
});

test("groups a missing signature across shops ranks and IDs with exact stable sorting", () => {
  const result = evaluateRunSkuCombinations(runInput({
    competitors: [
      bundleCompetitor("offer-z", 100_000, "AI-1", {
        shopName: "Shop B",
        searchRanks: [8, 2, 2],
        platformItemId: "item-z"
      }),
      bundleCompetitor("offer-a", 99_000, "AI-1", {
        shopName: "Shop A",
        searchRanks: [7],
        platformItemId: "item-a"
      }),
      competitor("third", 98_000, {
        shopName: "Shop C",
        searchRanks: [20],
        combination: signed(THIRD_SIGNATURE, "第三组合")
      }),
      competitor("unranked", 99_000, {
        shopName: "Shop D",
        searchRanks: [],
        combination: signed(SINGLE_SIGNATURE, "第一组合")
      }),
      competitor("aaa-fourth", 99_000, {
        shopName: "Shop E",
        searchRanks: [2],
        combination: signed(FOURTH_SIGNATURE, "第四组合")
      })
    ]
  }));

  assert.deepEqual(result.missingOwnGroups, [
    {
      combinationSignature: THIRD_SIGNATURE,
      combinationLabel: "第三组合",
      missingReason: "OWN_COMBINATION_ABSENT",
      earliestRank: 20,
      minimumConfirmedPayableFen: 98_000,
      shops: ["Shop C"],
      offerSnapshotIds: ["third"]
    },
    {
      combinationSignature: BUNDLE_SIGNATURE,
      combinationLabel: "RODE NT1S 新品 付费配件声卡AI-1x1",
      missingReason: "OWN_COMBINATION_ABSENT",
      earliestRank: 2,
      minimumConfirmedPayableFen: 99_000,
      shops: ["Shop A", "Shop B"],
      offerSnapshotIds: ["offer-a", "offer-z"]
    },
    {
      combinationSignature: FOURTH_SIGNATURE,
      combinationLabel: "第四组合",
      missingReason: "OWN_COMBINATION_ABSENT",
      earliestRank: 2,
      minimumConfirmedPayableFen: 99_000,
      shops: ["Shop E"],
      offerSnapshotIds: ["aaa-fourth"]
    },
    {
      combinationSignature: SINGLE_SIGNATURE,
      combinationLabel: "第一组合",
      missingReason: "OWN_COMBINATION_ABSENT",
      earliestRank: null,
      minimumConfirmedPayableFen: 99_000,
      shops: ["Shop D"],
      offerSnapshotIds: ["unranked"]
    }
  ]);
  assert.deepEqual(result.bySnapshotId.get("offer-z")?.reasons, ["OWN_COMBINATION_ABSENT"]);
  assert.equal(result.alertCandidates.length, 0);
});
