import assert from "node:assert/strict";
import test from "node:test";

import { resolveItemUrlIdentity } from "./item-url-identity.ts";

test("accepts agreeing item ID aliases and duplicate values", () => {
  const identity = resolveItemUrlIdentity(
    "https://item.example.test/item.htm?item_id=item-1&id=item-1&id=item-1#details",
    null
  );

  assert.equal(identity.platformItemId, "item-1");
  assert.equal(identity.url.includes("#"), false);
});

test("rejects conflicting or malformed URL item identities", () => {
  for (const url of [
    "https://item.example.test/item.htm?id=item-1&item_id=item-2",
    "https://item.example.test/item.htm?id=item-1&itemId=item-2",
    "https://item.example.test/item.htm?id=bad%20identity"
  ]) {
    assert.throws(() => resolveItemUrlIdentity(url, null), TypeError, url);
  }
});

test("preserves a recovered stable identity on a host-only detail URL", () => {
  assert.deepEqual(
    resolveItemUrlIdentity("https://item.example.test/item.htm", "recovered-item"),
    {
      url: "https://item.example.test/item.htm",
      platformItemId: "recovered-item"
    }
  );
});

test("rejects disagreement between observed and URL item identities", () => {
  assert.throws(
    () => resolveItemUrlIdentity("https://item.example.test/item.htm?id=url-item", "observed-item"),
    TypeError
  );
});
