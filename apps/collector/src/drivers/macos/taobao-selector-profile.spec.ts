import assert from "node:assert/strict";
import test from "node:test";

import { UiContractChangedError } from "../../core/desktop-driver.ts";
import type { AxNode } from "./ax-node.ts";
import { taobaoSelectorProfile } from "./taobao-selector-profile.ts";

function node(overrides: Partial<AxNode> = {}): AxNode {
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
    ...overrides
  };
}

function root(overrides: Partial<AxNode> = {}): AxNode {
  return node({ path: [], ...overrides });
}

test("selects the approved synthetic fixture profile", () => {
  assert.equal(taobaoSelectorProfile(root({
    fixtureMetadata: {
      kind: "synthetic-sanitized",
      profile: "taobao-desktop-2.4.5-build-15"
    },
    children: [node({ identifier: "search-region" })]
  })), "SYNTHETIC");
});

test("selects approved live fixtures and unlabelled raw trees", () => {
  assert.equal(taobaoSelectorProfile(root({
    fixtureMetadata: {
      kind: "live-sanitized",
      profile: "taobao-desktop-2.4.5-build-15"
    }
  })), "LIVE");
  assert.equal(taobaoSelectorProfile(root({
    children: [node({ role: "AXWebArea", url: "https://s.taobao.com/search?q=Example" })]
  })), "LIVE");
});

test("rejects unknown, unlabelled synthetic, and mixed profiles", () => {
  const unknown = root({
    fixtureMetadata: {
      kind: "live-sanitized",
      profile: "taobao-desktop-unsupported"
    }
  });
  const unlabelledSynthetic = root({
    children: [node({ identifier: "search-region" })]
  });
  const mixed = root({
    fixtureMetadata: {
      kind: "live-sanitized",
      profile: "taobao-desktop-2.4.5-build-15"
    },
    children: [node({ identifier: "search-region" })]
  });

  assert.throws(() => taobaoSelectorProfile(unknown), UiContractChangedError);
  assert.throws(() => taobaoSelectorProfile(unlabelledSynthetic), UiContractChangedError);
  assert.throws(() => taobaoSelectorProfile(mixed), UiContractChangedError);
});
