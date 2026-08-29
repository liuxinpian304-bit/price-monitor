import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { UiContractChangedError } from "../../core/desktop-driver.ts";
import { findAxNode, type AxNode } from "./ax-node.ts";
import {
  findSearchField,
  findSearchResultContainer,
  hasSearchEndMarker,
  readSearchCards,
  readSearchResultQuery
} from "./taobao-selectors.ts";

async function fixture(name: string): Promise<AxNode> {
  const url = new URL(`../../../test/fixtures/ax/${name}`, import.meta.url);
  return JSON.parse(await readFile(url, "utf8")) as AxNode;
}

function searchArea(root: AxNode): AxNode {
  return findAxNode(root, (node) => node.role === "AXWebArea") ?? assert.fail("search web area is missing");
}

function firstCardScope(root: AxNode): AxNode {
  return findAxNode(root, (node) => node.path.join(",") === "0,0,1,0,0") ?? assert.fail("first card scope is missing");
}

function staticText(path: number[], value: string, description: string): AxNode {
  return {
    path,
    role: "AXStaticText",
    subrole: null,
    identifier: null,
    title: null,
    description,
    value,
    url: null,
    enabled: null,
    selected: null,
    position: null,
    size: null,
    actions: [],
    children: []
  };
}

test("reads the unique live search field and query", async () => {
  const root = await fixture("live-search-results.json");
  assert.equal(findSearchField(root).description, "请输入搜索文字");
  assert.equal(readSearchResultQuery(root), "Example Interface X1");
  assert.equal(findSearchResultContainer(root).role, "AXWebArea");
});

test("preserves displayed duplicates and raw live action nodes", async () => {
  const cards = readSearchCards(await fixture("live-search-results.json"));
  assert.deepEqual(cards.map((card) => [
    card.rank,
    card.platformItemId,
    card.shopName,
    card.displayPriceMinText,
    card.displayPriceMaxText,
    card.sponsored
  ]), [
    [1, "example-x1-a", "Example Audio A", "699.00", "799.00", false],
    [2, "example-x1-a", "Example Audio A", "699.00", "799.00", false]
  ]);
  assert.equal(cards[0]?.actionNode.identifier, null);
  assert.notDeepEqual(cards[0]?.actionNode.path, cards[1]?.actionNode.path);
});

test("keeps sponsored positions and recognizes a verified live end", async () => {
  const root = await fixture("live-search-results-next.json");
  const cards = readSearchCards(root);
  assert.equal(cards[1]?.platformItemId, "example-x1-b");
  assert.equal(cards[1]?.sponsored, true);
  assert.equal(hasSearchEndMarker(root), true);
});

test("rejects a second enabled live search field", async () => {
  const root = structuredClone(await fixture("live-search-results.json"));
  searchArea(root).children.push({
    ...staticText([0, 0, 2], "Example Interface X1", "请输入搜索文字"),
    role: "AXTextField",
    enabled: true,
    actions: ["AXConfirm"]
  });
  assert.throws(() => findSearchField(root), UiContractChangedError);
});

test("rejects two distinct prices in one live card", async () => {
  const root = structuredClone(await fixture("live-search-results.json"));
  firstCardScope(root).children.push(staticText([0, 0, 1, 0, 0, 4], "700.00", "价格"));
  assert.throws(() => readSearchCards(root), UiContractChangedError);
});

test("rejects two distinct shop labels in one live card", async () => {
  const root = structuredClone(await fixture("live-search-results.json"));
  firstCardScope(root).children.push(staticText([0, 0, 1, 0, 0, 4], "Example Audio Other", "店铺"));
  assert.throws(() => readSearchCards(root), UiContractChangedError);
});

test("rejects conflicting product URLs within one live card scope", async () => {
  const root = structuredClone(await fixture("live-search-results.json"));
  firstCardScope(root).children[1]!.url = "https://detail.tmall.com/item.htm?id=example-x1-c";
  assert.throws(() => readSearchCards(root), UiContractChangedError);
});

test("rejects a live search query that disagrees with its URL", async () => {
  const root = structuredClone(await fixture("live-search-results.json"));
  searchArea(root).url = "https://s.taobao.com/search?q=Different%20Query";
  assert.throws(() => readSearchResultQuery(root), UiContractChangedError);
});

test("rejects conflicting repeated q parameters in a live search URL", async () => {
  const root = structuredClone(await fixture("live-search-results.json"));
  searchArea(root).url = "https://s.taobao.com/search?q=Example%20Interface%20X1&q=Different%20Query";
  assert.throws(() => readSearchResultQuery(root), UiContractChangedError);
});
