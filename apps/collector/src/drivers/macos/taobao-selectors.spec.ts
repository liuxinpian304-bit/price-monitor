import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { LoginRequiredError, PlatformChallengeError } from "../../core/desktop-driver.ts";
import type { AxNode } from "./ax-node.ts";
import {
  assertNoStopState,
  findSearchField,
  readDetailPage,
  readSearchCards,
  readSearchResultQuery,
  readSkuDimensions
} from "./taobao-selectors.ts";

async function fixture(name: string): Promise<AxNode> {
  const url = new URL(`../../../test/fixtures/ax/${name}`, import.meta.url);
  return JSON.parse(await readFile(url, "utf8")) as AxNode;
}

test("finds the search field by semantic role within the search region", async () => {
  const field = findSearchField(await fixture("search-results.json"));
  assert.equal(field.role, "AXTextField");
  assert.deepEqual(field.path, [0, 0, 0]);
  assert.equal(field.position, null);
  assert.equal(field.size, null);
});

test("reads ordered cards while preserving duplicate ranks and stable identities", async () => {
  const cards = readSearchCards(await fixture("search-results.json"));
  assert.deepEqual(cards.map((card) => ({
    rank: card.rank,
    id: card.platformItemId,
    title: card.title,
    shop: card.shopName,
    min: card.displayPriceMinText,
    max: card.displayPriceMaxText
  })), [
    { rank: 1, id: "example-7506", title: "Sony MDR-7506 监听耳机", shop: "示例音频店", min: "658.00", max: "728.00" },
    { rank: 2, id: "example-7506", title: "Sony MDR-7506 监听耳机", shop: "示例音频店", min: "658.00", max: "728.00" },
    { rank: 3, id: null, title: "MDR-7506 专业监听耳机", shop: "示例器材店", min: "699.00", max: "699.00" }
  ]);
  assert.equal(readSearchResultQuery(await fixture("search-results.json")), "索尼 7506");
});

test("distinguishes identical cards at a later scroll boundary by semantic AX occurrence", async () => {
  const first = readSearchCards(await fixture("search-results.json"))[0];
  const boundary = readSearchCards(await fixture("search-results-duplicate-boundary.json"))[0];
  assert.ok(first);
  assert.ok(boundary);
  assert.equal(first.title, boundary.title);
  assert.equal(first.url, boundary.url);
  assert.notDeepEqual(first.actionNode.path, boundary.actionNode.path);
});

test("reads detail title, shop, identity, and all SKU options from profiled regions", async () => {
  const root = await fixture("item-7506-default.json");
  const detail = readDetailPage(root);
  const dimensions = readSkuDimensions(root);

  assert.equal(detail.title, "Sony MDR-7506 监听耳机");
  assert.equal(detail.shopName, "示例音频店");
  assert.equal(detail.platformItemId, "example-7506");
  assert.deepEqual(dimensions.map((dimension) => ({
    name: dimension.name,
    labels: dimension.options.map((option) => option.label)
  })), [
    { name: "套装", labels: ["7506 单机", "7506 + C口转换线"] },
    { name: "转换线型号", labels: ["M1", "MV1"] }
  ]);
});

test("throws typed login and challenge stop errors before callers can mutate UI", async () => {
  const login = await fixture("login-required.json");
  const challenge = await fixture("platform-challenge.json");
  assert.throws(() => assertNoStopState(login), LoginRequiredError);
  assert.throws(() => assertNoStopState(challenge), PlatformChallengeError);
});
