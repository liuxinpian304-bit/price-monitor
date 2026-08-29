import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  LoginRequiredError,
  PlatformChallengeError,
  UiContractChangedError
} from "../../core/desktop-driver.ts";
import { findAxNode, type AxNode } from "./ax-node.ts";
import {
  assertNoStopState,
  findSkuOption,
  findSearchField,
  findSearchResultContainer,
  hasSearchEndMarker,
  readDetailPage,
  readSearchCards,
  readSearchResultQuery,
  readSelectedLabels,
  readSkuDimensions
} from "./taobao-selectors.ts";
import { parseLiveItemUrl } from "./taobao-url.ts";

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

function axNode(path: number[], values: Partial<Omit<AxNode, "path" | "children">> & { children?: AxNode[] } = {}): AxNode {
  return {
    path,
    role: "AXGroup",
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
    ...values
  };
}

function stopStateRoot(stateScope: AxNode): AxNode {
  return axNode([], {
    role: "AXApplication",
    children: [
      axNode([0], {
        role: "AXWebArea",
        title: "Example Results",
        url: "https://catalog.example.test/browse"
      }),
      stateScope
    ]
  });
}

type StopStateExpectation = "NONE" | "LOGIN" | "CHALLENGE";
type StopStateScope = "WEB_AREA" | "DIALOG";

function stopStateScope(
  scope: StopStateScope,
  title: string | null,
  url: string | null
): AxNode {
  return axNode([1], {
    role: scope === "DIALOG" ? "AXWindow" : "AXWebArea",
    subrole: scope === "DIALOG" ? "AXDialog" : null,
    title,
    url
  });
}

function assertStopState(root: AxNode, expected: StopStateExpectation): void {
  if (expected === "LOGIN") {
    assert.throws(() => assertNoStopState(root), LoginRequiredError);
    return;
  }
  if (expected === "CHALLENGE") {
    assert.throws(() => assertNoStopState(root), PlatformChallengeError);
    return;
  }
  assert.doesNotThrow(() => assertNoStopState(root));
}

test("ignores a fictional internal account-management loginPop frame", () => {
  const root = stopStateRoot(axNode([1], {
    role: "AXWebArea",
    title: "Account Settings",
    url: "file:///fictional/client/account-panel/loginPop/index.html",
    children: [
      axNode([1, 0], { role: "AXStaticText", value: "Account profile" }),
      axNode([1, 1], { role: "AXButton", title: "Sign out" }),
      axNode([1, 2], { role: "AXButton", title: "Switch account" })
    ]
  }));

  assert.doesNotThrow(() => assertNoStopState(root));
});

test("does not exempt a loginPop frame without confirmed account-management controls", () => {
  const root = stopStateRoot(axNode([1], {
    role: "AXWebArea",
    title: "Account Settings",
    url: "file:///fictional/client/account-panel/loginPop/index.html",
    children: [axNode([1, 0], { role: "AXStaticText", value: "Account profile" })]
  }));

  assert.throws(() => assertNoStopState(root), LoginRequiredError);
});

const stopStateCases: Array<{
  name: string;
  scope: StopStateScope;
  title: string | null;
  url: string | null;
  expected: StopStateExpectation;
}> = [
  {
    name: "stops for an HTTP external login URL",
    scope: "WEB_AREA",
    title: null,
    url: "http://portal.example.test/login",
    expected: "LOGIN"
  },
  {
    name: "stops for an HTTPS external login URL",
    scope: "WEB_AREA",
    title: null,
    url: "https://portal.example.test/login",
    expected: "LOGIN"
  },
  {
    name: "stops for a login token in an external hostname only",
    scope: "WEB_AREA",
    title: null,
    url: "https://login.example.test/continue",
    expected: "LOGIN"
  },
  {
    name: "stops for a login token in an external pathname only",
    scope: "WEB_AREA",
    title: null,
    url: "https://portal.example.test/login",
    expected: "LOGIN"
  },
  {
    name: "stops for an external security token only",
    scope: "WEB_AREA",
    title: null,
    url: "https://portal.example.test/security",
    expected: "CHALLENGE"
  },
  {
    name: "stops for an external punish token only",
    scope: "WEB_AREA",
    title: null,
    url: "https://portal.example.test/punish",
    expected: "CHALLENGE"
  },
  {
    name: "stops for a title-less app-bundled file login URL",
    scope: "WEB_AREA",
    title: null,
    url: "file:///Applications/FictionalTaobao.app/Contents/Resources/login/index.html",
    expected: "LOGIN"
  },
  {
    name: "stops for a title-less app-bundled file challenge URL",
    scope: "WEB_AREA",
    title: null,
    url: "file:///Applications/FictionalTaobao.app/Contents/Resources/security/challenge.html",
    expected: "CHALLENGE"
  },
  {
    name: "ignores an attacker-shaped javascript URL by itself",
    scope: "WEB_AREA",
    title: null,
    url: "javascript:login()",
    expected: "NONE"
  },
  {
    name: "ignores an attacker-shaped custom security URL by itself",
    scope: "WEB_AREA",
    title: null,
    url: "fictional-security://portal.example.test/punish",
    expected: "NONE"
  },
  {
    name: "keeps a dialog login title terminal regardless of its file URL",
    scope: "DIALOG",
    title: "请登录",
    url: "file:///fictional/client/account-panel/index.html",
    expected: "LOGIN"
  },
  {
    name: "keeps a dialog challenge title terminal regardless of its custom URL",
    scope: "DIALOG",
    title: "安全验证",
    url: "fictional-security://portal.example.test/notice",
    expected: "CHALLENGE"
  },
  {
    name: "stops for a dialog external login URL without a semantic title",
    scope: "DIALOG",
    title: null,
    url: "https://portal.example.test/login",
    expected: "LOGIN"
  },
  {
    name: "stops for a dialog external challenge URL without a semantic title",
    scope: "DIALOG",
    title: null,
    url: "https://portal.example.test/security",
    expected: "CHALLENGE"
  }
];

for (const stopStateCase of stopStateCases) {
  test(stopStateCase.name, () => {
    assertStopState(
      stopStateRoot(stopStateScope(stopStateCase.scope, stopStateCase.title, stopStateCase.url)),
      stopStateCase.expected
    );
  });
}

function detailArea(root: AxNode): AxNode {
  return findAxNode(root, (node) => node.role === "AXWebArea" && node.title === "商品详情")
    ?? assert.fail("detail web area is missing");
}

function purchaseRegion(root: AxNode): AxNode {
  return detailArea(root).children[0] ?? assert.fail("purchase region is missing");
}

function skuOption(root: AxNode, dimensionIndex: number, optionIndex: number): AxNode {
  return purchaseRegion(root).children[dimensionIndex + 3]?.children[1]?.children[optionIndex]
    ?? assert.fail("SKU option is missing");
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

test("ignores a pressable shop link inside a live product card", async () => {
  const root = structuredClone(await fixture("live-search-results.json"));
  firstCardScope(root).children.push(axNode([0, 0, 1, 0, 0, 4], {
    role: "AXLink",
    title: "Example Audio A",
    url: "https://shop.taobao.com/shop/view_shop.htm?user_number_id=fictional-a",
    enabled: true,
    actions: ["AXPress"]
  }));

  const cards = readSearchCards(root);

  assert.deepEqual(cards.map((card) => card.platformItemId), ["example-x1-a", "example-x1-a"]);
});

test("ignores a pressable page navigation link outside live product cards", async () => {
  const root = structuredClone(await fixture("live-search-results.json"));
  searchArea(root).children.push(axNode([0, 0, 2], {
    role: "AXLink",
    title: "Next results page",
    url: "https://s.taobao.com/search?page=2",
    enabled: true,
    actions: ["AXPress"]
  }));

  const cards = readSearchCards(root);

  assert.deepEqual(cards.map((card) => card.platformItemId), ["example-x1-a", "example-x1-a"]);
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

test("rejects non-web and non-item live product URLs", () => {
  for (const url of [
    "ftp://detail.tmall.com/item.htm?id=example-x1-a",
    "custom://item.taobao.com/account?id=example-x1-a",
    "https://detail.tmall.com/account?id=example-x1-a",
    "https://click.simba.taobao.com/account?id=example-x1-a"
  ]) {
    assert.throws(() => parseLiveItemUrl(url), UiContractChangedError, url);
  }
});

test("requires an HTTP(S) Taobao search URL at the exact search path", async () => {
  for (const url of [
    "custom://s.taobao.com/search?q=Example%20Interface%20X1",
    "https://s.taobao.com/account?q=Example%20Interface%20X1"
  ]) {
    const root = structuredClone(await fixture("live-search-results.json"));
    searchArea(root).url = url;
    assert.throws(() => findSearchResultContainer(root), UiContractChangedError, url);
  }
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

test("reads a unique live detail and all SKU dimensions", async () => {
  const root = await fixture("live-item-x1-default.json");
  const detail = readDetailPage(root);
  assert.deepEqual({
    id: detail.platformItemId,
    title: detail.title,
    shop: detail.shopName
  }, {
    id: "example-x1-a",
    title: "Example Interface X1",
    shop: "Example Audio A"
  });
  assert.strictEqual(detail.shareNode, purchaseRegion(root).children[2]);

  const dimensions = readSkuDimensions(root);
  assert.deepEqual(dimensions.map((dimension) => [
    dimension.name,
    dimension.options.map((option) => option.label)
  ]), [
    ["套餐", ["单机", "麦克风套装"]],
    ["颜色", ["银色", "黑色"]]
  ]);
  for (const option of dimensions.flatMap((dimension) => dimension.options)) {
    assert.match(option.id, /^live-sku-[a-f0-9]{24}$/);
  }
  assert.equal(dimensions[0]?.options[0]?.id, "live-sku-001cfeaba2e5d72e5673b495");
});

test("returns raw action nodes while SKU IDs remain data only", async () => {
  const root = await fixture("live-item-x1-default.json");
  const option = findSkuOption(root, "套餐", "麦克风套装");
  assert.equal(option.identifier, null);
  assert.equal(option.actions.includes("AXPress"), true);
  assert.strictEqual(option, skuOption(root, 0, 1));
  assert.deepEqual(readSelectedLabels(root), { "套餐": "单机", "颜色": "银色" });
});

test("reads the selected labels from the bundle detail fixture", async () => {
  assert.deepEqual(readSelectedLabels(await fixture("live-item-x1-bundle.json")), {
    "套餐": "麦克风套装",
    "颜色": "黑色"
  });
});

test("rejects two live detail web areas", async () => {
  const root = structuredClone(await fixture("live-item-x1-default.json"));
  root.children[0]?.children.push(structuredClone(detailArea(root)));
  assert.throws(() => readDetailPage(root), UiContractChangedError);
});

test("rejects two live purchase regions", async () => {
  const root = structuredClone(await fixture("live-item-x1-default.json"));
  detailArea(root).children.push(structuredClone(purchaseRegion(root)));
  assert.throws(() => readDetailPage(root), UiContractChangedError);
});

test("rejects duplicate live SKU dimension labels", async () => {
  const root = structuredClone(await fixture("live-item-x1-default.json"));
  const colorLabel = purchaseRegion(root).children[4]?.children[0] ?? assert.fail("color label is missing");
  colorLabel.value = "套餐";
  assert.throws(() => readSkuDimensions(root), UiContractChangedError);
});

test("rejects duplicate live SKU option labels", async () => {
  const root = structuredClone(await fixture("live-item-x1-default.json"));
  skuOption(root, 0, 1).title = "单机";
  assert.throws(() => readSkuDimensions(root), UiContractChangedError);
});

test("rejects a live SKU dimension with a second descendant option group", async () => {
  const root = structuredClone(await fixture("live-item-x1-default.json"));
  const dimension = purchaseRegion(root).children[3] ?? assert.fail("package dimension is missing");
  const optionGroup = dimension.children[1] ?? assert.fail("package option group is missing");
  dimension.children.push({ ...structuredClone(optionGroup), children: [structuredClone(optionGroup)] });
  assert.throws(() => readSkuDimensions(root), UiContractChangedError);
});

test("rejects a live SKU dimension with a third non-option child", async () => {
  const root = structuredClone(await fixture("live-item-x1-default.json"));
  const dimension = purchaseRegion(root).children[3] ?? assert.fail("package dimension is missing");
  dimension.children.push(staticText([0, 0, 0, 3, 2], "仅作提示", "规格提示"));
  assert.throws(() => readSkuDimensions(root), UiContractChangedError);
});

test("rejects a live SKU dimension with no selected option", async () => {
  const root = structuredClone(await fixture("live-item-x1-default.json"));
  skuOption(root, 0, 0).selected = false;
  assert.throws(() => readSelectedLabels(root), UiContractChangedError);
});

test("rejects a live SKU dimension with two selected options", async () => {
  const root = structuredClone(await fixture("live-item-x1-default.json"));
  skuOption(root, 0, 1).selected = true;
  assert.throws(() => readSelectedLabels(root), UiContractChangedError);
});
