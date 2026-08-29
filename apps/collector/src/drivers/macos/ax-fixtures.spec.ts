import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

import type { AxNode } from "./ax-node.ts";
import { readSearchCards } from "./taobao-selectors.ts";

const fixtureDirectory = new URL("../../../test/fixtures/ax/", import.meta.url);

function assertValidPaths(node: AxNode): void {
  node.children.forEach((child, index) => {
    assert.deepEqual(
      child.path,
      [...node.path, index],
      `${child.identifier ?? child.role ?? "unknown node"} has a path Swift cannot resolve`
    );
    assertValidPaths(child);
  });
}

function resolvePath(root: AxNode, path: number[]): AxNode {
  let current = root;
  for (const index of path) {
    current = current.children[index] ?? assert.fail(`Path ${JSON.stringify(path)} is not resolvable`);
  }
  return current;
}

test("every committed AX fixture path equals its recursive child index", async () => {
  const names = (await readdir(fixtureDirectory)).filter((name) => name.endsWith(".json")).sort();
  assert.deepEqual(names, [
    "item-7506-cable.json",
    "item-7506-default.json",
    "live-item-x1-bundle.json",
    "live-item-x1-default.json",
    "live-search-results-next.json",
    "live-search-results.json",
    "login-required.json",
    "platform-challenge.json",
    "search-results-duplicate-boundary.json",
    "search-results.json"
  ]);
  for (const name of names) {
    const root = JSON.parse(await readFile(new URL(name, fixtureDirectory), "utf8")) as AxNode;
    assertValidPaths(root);
  }
});

test("search selector action paths resolve to their intended fixture link nodes", async () => {
  for (const name of ["search-results.json", "search-results-duplicate-boundary.json"]) {
    const root = JSON.parse(await readFile(new URL(name, fixtureDirectory), "utf8")) as AxNode;
    for (const card of readSearchCards(root)) {
      const resolved = resolvePath(root, card.actionNode.path);
      assert.equal(resolved.identifier, "item-link");
      assert.equal(resolved.role, "AXLink");
      assert.equal(resolved.url, card.actionNode.url);
    }
  }
});
