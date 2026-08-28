import assert from "node:assert/strict";
import test from "node:test";

import { deriveOwnCatalogCompleteness } from "./own-catalog-completeness.ts";

const claimedOwnListings = [
  { id: "listing-a", platformItemId: "own-a" },
  { id: "listing-b", platformItemId: "own-b" }
];
const ownSnapshots = [
  { ownListingId: "listing-a", platformItemId: "own-a", skuId: "a-1" },
  { ownListingId: "listing-b", platformItemId: "own-b", skuId: "b-1" }
];

test("requires every claimed own listing to produce at least one snapshot", () => {
  const complete = deriveOwnCatalogCompleteness({
    claimedOwnListings,
    ownSnapshots,
    issues: []
  });
  const partial = deriveOwnCatalogCompleteness({
    claimedOwnListings,
    ownSnapshots: ownSnapshots.slice(0, 1),
    issues: []
  });

  assert.deepEqual(complete, {
    complete: true,
    configuredListingCount: 2,
    collectedListingCount: 2
  });
  assert.equal(partial.complete, false);
  assert.equal(partial.collectedListingCount, 1);
});

test("fails closed for own-item enumeration selection price and detail failures", () => {
  for (const code of [
    "ITEM_UNAVAILABLE",
    "SKU_ENUMERATION_INCOMPLETE",
    "SKU_SELECTION_MISMATCH",
    "PRICE_UNSTABLE"
  ]) {
    const result = deriveOwnCatalogCompleteness({
      claimedOwnListings,
      ownSnapshots,
      issues: [{ code, platformItemId: "own-a", skuId: "a-2" }]
    });

    assert.equal(result.complete, false, code);
  }
});

test("does not treat a competitor item failure as an own catalog failure", () => {
  const result = deriveOwnCatalogCompleteness({
    claimedOwnListings,
    ownSnapshots,
    issues: [{
      code: "SKU_ENUMERATION_INCOMPLETE",
      platformItemId: "competitor-a",
      skuId: "competitor-sku"
    }]
  });

  assert.equal(result.complete, true);
});

test("fails closed for unattributed collection-contract failures", () => {
  for (const code of ["MISSING_ITEM_ID", "UI_CONTRACT_CHANGED"]) {
    const result = deriveOwnCatalogCompleteness({
      claimedOwnListings,
      ownSnapshots,
      issues: [{ code, platformItemId: null, skuId: null }]
    });

    assert.equal(result.complete, false, code);
  }
});
