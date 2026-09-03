import assert from "node:assert/strict";
import test from "node:test";

import { hasDomClassPrefix, type AxNode } from "./ax-node.ts";

function node(domClassList: unknown): AxNode {
  return {
    path: [],
    role: null,
    subrole: null,
    identifier: null,
    title: null,
    description: null,
    value: null,
    url: null,
    enabled: null,
    selected: null,
    position: null,
    size: null,
    actions: [],
    children: [],
    domClassList
  } as AxNode;
}

test("matches only a present DOM class prefix", () => {
  assert.equal(hasDomClassPrefix(node(undefined), "isSelected--"), false);
  assert.equal(hasDomClassPrefix(node(["valueItem--fixture", "isSelected--fixture"]), "isSelected--"), true);
  assert.equal(hasDomClassPrefix(node(["valueItem--fixture"]), "isSelected--"), false);
  assert.equal(hasDomClassPrefix(node({ startsWith: "isSelected--" }), "isSelected--"), false);
});
