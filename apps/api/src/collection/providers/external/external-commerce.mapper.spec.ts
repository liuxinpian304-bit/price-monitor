import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  OfferUnavailableError,
  ProviderContractChangedError,
  ProviderRateLimitedError
} from "../commerce-provider.ts";
import { ExternalCommerceProvider } from "./external-commerce.provider.ts";
import { mapExternalOffer, mapExternalSearch } from "./external-commerce.mapper.ts";
import { ManualImportProvider } from "../manual/manual-import.provider.ts";

const FIXTURE_ROOT = new URL("../../../../../../tests/fixtures/providers/", import.meta.url);

async function fixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(new URL(name, FIXTURE_ROOT), "utf8"));
}

test("maps keyword search results without treating the displayed minimum as a SKU price", async () => {
  const hits = mapExternalSearch(await fixture("search-results.json"));

  assert.equal(hits.length, 2);
  assert.deepEqual(hits[0]?.displayPriceRangeFen, { minFen: 12_345, maxFen: 470_100 });
  assert.equal("payableFen" in hits[0]!, false);
});

test("maps exact SKU prices, public promotions, gifts, stock and evidence", async () => {
  const offer = mapExternalOffer(await fixture("product-bare.json"));

  assert.equal(offer.platformItemId, "1001");
  assert.equal(offer.selectedSkuId, "sku-bare");
  assert.equal(offer.listPriceFen, 470_100);
  assert.equal(offer.skuOptions[0]?.payableFen, 460_100);
  assert.equal(offer.skuOptions[0]?.stockState, "IN_STOCK");
  assert.equal(offer.promotions[0]?.amountFen, 10_000);
  assert.deepEqual(offer.gifts[0], { name: "STAU双卡农音频线", quantity: 1 });
  assert.equal(offer.capturedAt.toISOString(), "2026-08-19T01:30:00.000Z");
});

test("keeps every concrete bundle SKU separate", async () => {
  const offer = mapExternalOffer(await fixture("product-bundle.json"));

  assert.equal(offer.skuOptions.length, 2);
  assert.deepEqual(offer.skuOptions.map((sku) => sku.payableFen), [560_100, 660_100]);
  assert.deepEqual(offer.skuOptions.map((sku) => sku.stockState), ["IN_STOCK", "OUT_OF_STOCK"]);
});

test("raises typed errors for rate limits, missing fields and unavailable offers", async () => {
  assert.throws(
    () => mapExternalSearch({ status: "ok", data: { items: [{ item_id: "1001" }] } }),
    ProviderContractChangedError
  );
  assert.throws(
    () => mapExternalSearch({ status: "unavailable", message: "item removed" }),
    OfferUnavailableError
  );

  try {
    mapExternalSearch(await fixture("rate-limited.json"));
    assert.fail("expected a rate limit error");
  } catch (error) {
    assert.ok(error instanceof ProviderRateLimitedError);
    assert.equal(error.retryAfterSeconds, 120);
  }
});

test("manual fixtures and an external transport expose the same provider contract", async () => {
  const searchResponse = await fixture("search-results.json");
  const offerResponse = await fixture("product-bare.json");
  const url = "https://example.com/fixtures/bare";
  const transport = {
    search: async () => searchResponse,
    fetchOffer: async () => offerResponse
  };
  const external = new ExternalCommerceProvider(transport);
  const manual = new ManualImportProvider({ searchResponse, offersByUrl: new Map([[url, offerResponse]]) });

  assert.deepEqual(await manual.search("Babyface Pro FS"), await external.search("Babyface Pro FS"));
  assert.deepEqual(await manual.fetchOffer(url), await external.fetchOffer(url));
});
