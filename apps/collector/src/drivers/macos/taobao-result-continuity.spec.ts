import assert from "node:assert/strict";
import test from "node:test";

import type { AxNode } from "./ax-node.ts";
import { mergeSearchCardViewports } from "./taobao-mac-driver.ts";
import type { SelectedSearchCard } from "./taobao-selectors.ts";

function node(path: number[]): AxNode {
  return {
    path,
    role: "AXLink",
    subrole: null,
    identifier: "item-link",
    title: "重复商品",
    description: "商品标题",
    value: null,
    url: "https://item.example.test/item.htm?id=duplicate",
    enabled: true,
    selected: null,
    position: null,
    size: null,
    actions: ["AXPress"],
    children: []
  };
}

function card(pathIndex: number): SelectedSearchCard {
  const actionNode = node([0, 1, pathIndex, 0]);
  return {
    rank: 1,
    platformItemId: "duplicate",
    url: "https://item.example.test/item.htm?id=duplicate",
    title: "重复商品",
    shopName: "示例店",
    displayPriceMinText: "100.00",
    displayPriceMaxText: "100.00",
    sponsored: false,
    actionNode,
    cardNode: { ...actionNode, path: [0, 1, pathIndex], role: "AXGroup", actions: [], children: [actionNode] }
  };
}

test("merges A1,A2 then A2,A3 as three distinct stable AX occurrences", () => {
  const merged = mergeSearchCardViewports([card(1), card(2)], [card(2), card(3)]);
  assert.deepEqual(merged.map((entry) => entry.actionNode.path[2]), [1, 2, 3]);
});

test("does not fabricate cards for an exactly unchanged viewport", () => {
  const merged = mergeSearchCardViewports([card(1), card(2)], [card(1), card(2)]);
  assert.deepEqual(merged.map((entry) => entry.actionNode.path[2]), [1, 2]);
});

test("does not fabricate cards when known siblings reorder without strict overlap", () => {
  const merged = mergeSearchCardViewports(
    [card(1), card(2), card(3)],
    [card(2), card(1), card(3)]
  );
  assert.deepEqual(merged.map((entry) => entry.actionNode.path[2]), [1, 2, 3]);
});
