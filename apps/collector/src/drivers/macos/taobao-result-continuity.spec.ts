import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type { AxNode } from "./ax-node.ts";
import { mergeSearchCardViewports } from "./taobao-mac-driver.ts";
import { readSearchCards, type SelectedSearchCard } from "./taobao-selectors.ts";

async function fixture(name: string): Promise<AxNode> {
  const url = new URL(`../../../test/fixtures/ax/${name}`, import.meta.url);
  return JSON.parse(await readFile(url, "utf8")) as AxNode;
}

function node(path: number[], semanticId = "duplicate"): AxNode {
  return {
    path,
    role: "AXLink",
    subrole: null,
    identifier: "item-link",
    title: `商品 ${semanticId}`,
    description: "商品标题",
    value: null,
    url: `https://item.example.test/item.htm?id=${semanticId}`,
    enabled: true,
    selected: null,
    position: null,
    size: null,
    actions: ["AXPress"],
    children: []
  };
}

function card(pathIndex: number, semanticId = "duplicate"): SelectedSearchCard {
  const actionNode = node([0, 1, pathIndex, 0], semanticId);
  return {
    rank: 1,
    platformItemId: semanticId,
    url: `https://item.example.test/item.htm?id=${semanticId}`,
    title: `商品 ${semanticId}`,
    shopName: "示例店",
    displayPriceMinText: "100.00",
    displayPriceMaxText: "100.00",
    sponsored: false,
    actionNode,
    cardNode: { ...actionNode, path: [0, 1, pathIndex], role: "AXGroup", actions: [], children: [actionNode] }
  };
}

function regeneratePaths(node: AxNode, path: number[] = []): void {
  node.path = path;
  node.children.forEach((child, index) => regeneratePaths(child, [...path, index]));
}

function searchResultContainer(root: AxNode): AxNode {
  const container = root.children[0]?.children.find((child) => child.identifier === "search-result-list");
  assert.ok(container);
  return container;
}

function resolvePath(root: AxNode, path: number[]): AxNode {
  let current = root;
  for (const index of path) {
    current = current.children[index] ?? assert.fail(`Unresolvable action path ${JSON.stringify(path)}`);
  }
  return current;
}

test("merges A1,A2 then A2,A3 as three distinct stable AX occurrences", () => {
  const previous = [card(1), card(2)];
  const current = [card(2), card(3)];
  const merged = mergeSearchCardViewports(previous, current);
  assert.deepEqual(merged.map((entry) => entry.actionNode.path[2]), [1, 2, 3]);
  assert.equal(merged[0], previous[0]);
  assert.equal(merged[1], previous[1]);
  assert.equal(merged[2], current[1]);
});

test("does not fabricate cards for an exactly unchanged viewport", () => {
  const merged = mergeSearchCardViewports([card(1), card(2)], [card(1), card(2)]);
  assert.deepEqual(merged.map((entry) => entry.actionNode.path[2]), [1, 2]);
});

test("does not fabricate cards for an equal duplicate-count multiset with regenerated paths", () => {
  const merged = mergeSearchCardViewports(
    [card(1, "A"), card(2, "A"), card(3, "B"), card(4, "B")],
    [card(1, "B"), card(2, "A"), card(3, "B"), card(4, "A")]
  );
  assert.deepEqual(merged.map((entry) => entry.platformItemId), ["A", "A", "B", "B"]);
});

test("appends only the non-overlapping tail when a mixed viewport has a true new card", () => {
  const merged = mergeSearchCardViewports(
    [card(1, "A"), card(2, "B"), card(3, "C")],
    [card(2, "B"), card(3, "C"), card(4, "D")]
  );
  assert.deepEqual(merged.map((entry) => entry.platformItemId), ["A", "B", "C", "D"]);
});

test("reconciles a real recursively rebased AX sibling reorder without stale action reuse", async () => {
  const previousRoot = await fixture("search-results.json");
  const currentRoot = structuredClone(previousRoot);
  const container = searchResultContainer(currentRoot);
  const marker = container.children.find((child) => child.identifier === "search-result-query-marker");
  const end = container.children.find((child) => child.identifier === "search-end-marker");
  const cards = container.children.filter((child) => child.identifier === "result-card");
  assert.ok(marker);
  assert.ok(end);
  assert.equal(cards.length, 3);
  container.children = [marker, cards[2]!, cards[0]!, cards[1]!, end];
  regeneratePaths(currentRoot);

  const previous = readSearchCards(previousRoot);
  const current = readSearchCards(currentRoot);
  assert.deepEqual(current.map((entry) => entry.platformItemId), [null, "example-7506", "example-7506"]);
  assert.deepEqual(current.map((entry) => entry.actionNode.path[2]), [1, 2, 3]);

  const merged = mergeSearchCardViewports(previous, current);
  assert.equal(merged.length, 3);
  assert.deepEqual(merged.map((entry) => entry.platformItemId), ["example-7506", "example-7506", null]);
  for (const mergedCard of merged) {
    assert.equal(previous.includes(mergedCard), true);
    const resolved = resolvePath(previousRoot, mergedCard.actionNode.path);
    assert.equal(resolved.identifier, "item-link");
    assert.equal(resolved.url, mergedCard.actionNode.url);
  }
});
