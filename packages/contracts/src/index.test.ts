import assert from "node:assert/strict";
import test from "node:test";

import { ALERT_STATUSES, COMPARISON_TYPES } from "./index.ts";

test("exposes the approved comparison types", () => {
  assert.deepEqual(COMPARISON_TYPES, ["BARE", "BUNDLE"]);
});

test("exposes every operator alert status", () => {
  assert.deepEqual(ALERT_STATUSES, [
    "PENDING",
    "PRICE_CHANGED",
    "NO_FOLLOW",
    "FALSE_POSITIVE",
    "WATCHING"
  ]);
});
