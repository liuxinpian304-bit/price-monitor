import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  LoginRequiredError,
  PlatformChallengeError,
  UiContractChangedError
} from "../../core/desktop-driver.ts";
import { findAxNode, walkAxNodes, type AxNode } from "./ax-node.ts";
import {
  assertNoStopState,
  findSkuOption,
  findSearchField,
  findSearchResultContainer,
  hasSearchEndMarker,
  readDetailPage,
  readSearchAdvance,
  readSearchCards,
  readSearchPaginationState,
  readSearchResultQuery,
  readSearchRetreat,
  readSelectedLabels,
  readSkuDimensions
} from "./taobao-selectors.ts";
import { liveFindBackAction, liveFindSearchSubmitButton } from "./taobao-live-selectors.ts";
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

const SEARCH_SHOP_DESCRIPTIONS = new Set(["店铺", "店铺名称"]);

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

function removeExplicitShopEvidence(scope: AxNode): void {
  for (const node of walkAxNodes(scope)) {
    if (node.description && SEARCH_SHOP_DESCRIPTIONS.has(node.description)) {
      node.description = null;
    }
  }
}

function appendShopLink(
  scope: AxNode,
  childIndex: number,
  title: string,
  url: string,
  options: { enabled?: boolean; actions?: readonly string[] } = {}
): void {
  scope.children.push(axNode([...scope.path, childIndex], {
    role: "AXLink",
    title,
    url,
    enabled: options.enabled ?? true,
    actions: options.actions ? [...options.actions] : ["AXPress"]
  }));
}

interface SplitPriceOptions {
  major?: string;
  fraction?: string;
  currencyCount?: number;
  majorRole?: string;
  fractionRole?: string;
  majorPosition?: { x: number; y: number } | null;
  majorSize?: { width: number; height: number } | null;
  fractionPosition?: { x: number; y: number } | null;
  fractionSize?: { width: number; height: number } | null;
  duplicateMajor?: boolean;
  thirdNumeric?: string | null;
}

interface DomPriceOptions {
  major: string;
  fraction?: string;
  extraNumericText?: string;
}

function replaceFirstCardPriceWithDom(
  root: AxNode,
  options: DomPriceOptions
): void {
  const scope = firstCardScope(root);
  const priceIndex = scope.children.findIndex((node) => node.description === "价格");
  assert.notEqual(priceIndex, -1);
  const currency = axNode([...scope.path, priceIndex, 0], {
    role: "AXStaticText",
    value: "¥",
    enabled: true,
    position: { x: 100, y: 100 },
    size: { width: 10, height: 20 }
  });
  const major = axNode([...scope.path, priceIndex, 1], {
    domClassList: ["priceInt--fixture"],
    children: [axNode([...scope.path, priceIndex, 1, 0], {
      role: "AXStaticText",
      value: options.major,
      enabled: true,
      position: { x: 120, y: 100 },
      size: { width: 100, height: 20 }
    })]
  });
  const priceChildren = [currency, major];
  if (options.fraction) {
    priceChildren.push(axNode([...scope.path, priceIndex, 2], {
      domClassList: ["priceFloat--fixture"],
      children: [axNode([...scope.path, priceIndex, 2, 0], {
        role: "AXStaticText",
        value: options.fraction,
        enabled: true,
        position: { x: 195, y: 100 },
        size: { width: 10, height: 20 }
      })]
    }));
  }
  const priceWrapper = axNode([...scope.path, priceIndex], {
    domClassList: ["innerNormalPriceWrapper--fixture"],
    children: priceChildren
  });
  const replacements: AxNode[] = [priceWrapper];
  if (options.extraNumericText) {
    replacements.unshift(axNode([...scope.path, priceIndex], {
      role: "AXStaticText",
      value: options.extraNumericText,
      enabled: true,
      position: { x: 195, y: 100 },
      size: { width: 10, height: 20 }
    }));
    priceWrapper.path = [...scope.path, priceIndex + 1];
    priceWrapper.children.forEach((child, index) => {
      child.path = [...priceWrapper.path, index];
      child.children.forEach((grandchild, childIndex) => {
        grandchild.path = [...child.path, childIndex];
      });
    });
  }
  scope.children.splice(priceIndex, 1, ...replacements);
}

function replaceFirstCardPriceWithSplit(
  root: AxNode,
  options: SplitPriceOptions = {}
): void {
  const scope = firstCardScope(root);
  const priceIndex = scope.children.findIndex((node) => node.description === "价格");
  assert.notEqual(priceIndex, -1);
  const major = options.major ?? "4999";
  const fraction = options.fraction ?? "9";
  const currencyCount = options.currencyCount ?? 1;
  const majorNode = axNode([...scope.path, priceIndex], {
    role: options.majorRole ?? "AXStaticText",
    value: major,
    enabled: true,
    position: options.majorPosition === undefined ? { x: 120, y: 100 } : options.majorPosition,
    size: options.majorSize === undefined ? { width: 100, height: 20 } : options.majorSize
  });
  const fractionNode = axNode([...scope.path, priceIndex + 1], {
    role: options.fractionRole ?? "AXStaticText",
    value: fraction,
    enabled: true,
    position: options.fractionPosition === undefined ? { x: 195, y: 100 } : options.fractionPosition,
    size: options.fractionSize === undefined ? { width: 10, height: 20 } : options.fractionSize
  });
  const replacements: AxNode[] = [
    ...Array.from({ length: currencyCount }, (_, index) => axNode([...scope.path, priceIndex + index + 2], {
      role: "AXStaticText",
      value: index === 0 ? "¥" : "￥",
      enabled: true,
      position: { x: 100 - index * 10, y: 100 },
      size: { width: 10, height: 20 }
    })),
    majorNode,
    fractionNode
  ];
  if (options.duplicateMajor) replacements.push(structuredClone(majorNode));
  if (options.thirdNumeric) replacements.push(axNode([...scope.path, priceIndex + replacements.length], {
    role: "AXStaticText",
    value: options.thirdNumeric,
    enabled: true,
    position: { x: 250, y: 100 },
    size: { width: 20, height: 20 }
  }));
  scope.children.splice(priceIndex, 1, ...replacements);
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

test("finds the verified back control when unrelated pressable nodes omit nullable fields", () => {
  const root = {
    path: [],
    role: "AXApplication",
    actions: [],
    children: [
      { path: [0], role: "AXButton", enabled: true, actions: ["AXPress"], children: [] },
      { path: [1], role: "AXRadioButton", enabled: true, actions: ["AXPress"], children: [] },
      {
        path: [2],
        role: "AXButton",
        title: "返回",
        enabled: true,
        actions: ["AXPress"],
        children: []
      }
    ]
  } as unknown as AxNode;

  assert.doesNotThrow(() => liveFindBackAction(root, "RME Babyface"));
  assert.equal(liveFindBackAction(root, "RME Babyface").path.join(","), "2");
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

test("ignores the Taobao pages/loginPop account-management frame when logged-in controls are present", () => {
  const root = stopStateRoot(axNode([1], {
    role: "AXWebArea",
    title: "账号管理",
    url: "file:///Applications/Taobao.app/Contents/Resources/app/pages/loginPop/index.html",
    children: [
      axNode([1, 0], { role: "AXButton", title: "退出登录" }),
      axNode([1, 1], { role: "AXButton", title: "切换账号" })
    ]
  }));

  assert.doesNotThrow(() => assertNoStopState(root));
});

test("does not exempt the Taobao pages/loginPop frame when either logged-in control is missing", () => {
  for (const onlyControl of ["退出登录", "切换账号"] as const) {
    const root = stopStateRoot(axNode([1], {
      role: "AXWebArea",
      title: "账号管理",
      url: "file:///Applications/Taobao.app/Contents/Resources/app/pages/loginPop/index.html",
      children: [axNode([1, 0], { role: "AXButton", title: onlyControl })]
    }));

    assert.throws(() => assertNoStopState(root), LoginRequiredError, onlyControl);
  }
});

test("ignores the Taobao pages/loginPop 登陆 title when logged-in controls are present", () => {
  const root = stopStateRoot(axNode([1], {
    role: "AXWebArea",
    title: "登陆",
    url: "file:///Applications/Taobao.app/Contents/Resources/app/pages/loginPop/index.html",
    children: [
      axNode([1, 0], { role: "AXButton", title: "退出登录" }),
      axNode([1, 1], { role: "AXButton", title: "切换账号" })
    ]
  }));

  assert.doesNotThrow(() => assertNoStopState(root));
});

test("does not exempt the Taobao pages/loginPop 登陆 title when either logged-in control is missing", () => {
  for (const onlyControl of ["退出登录", "切换账号"] as const) {
    const root = stopStateRoot(axNode([1], {
      role: "AXWebArea",
      title: "登陆",
      url: "file:///Applications/Taobao.app/Contents/Resources/app/pages/loginPop/index.html",
      children: [axNode([1, 0], { role: "AXButton", title: onlyControl })]
    }));

    assert.throws(() => assertNoStopState(root), LoginRequiredError, onlyControl);
  }
});

test("stops for an enabled pressable login action inside an ordinary web area", () => {
  const root = stopStateRoot(axNode([1], {
    role: "AXWebArea",
    title: "首页",
    url: "https://pages.example.test/home",
    children: [axNode([1, 0], {
      role: "AXButton",
      title: "立即登录",
      enabled: true,
      actions: ["AXPress"]
    })]
  }));

  assert.throws(() => assertNoStopState(root), LoginRequiredError);
});

test("does not treat disabled or non-action login copy as a confirmed login stop", () => {
  for (const child of [
    axNode([1, 0], { role: "AXButton", title: "立即登录", enabled: false, actions: ["AXPress"] }),
    axNode([1, 0], { role: "AXStaticText", value: "立即登录" })
  ]) {
    const root = stopStateRoot(axNode([1], {
      role: "AXWebArea",
      title: "首页",
      url: "https://pages.example.test/home",
      children: [child]
    }));
    assert.doesNotThrow(() => assertNoStopState(root));
  }
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

function domPurchaseRegion(root: AxNode): AxNode {
  return detailArea(root).children[0] ?? assert.fail("DOM purchase region is missing");
}

function domShopLink(root: AxNode): AxNode {
  return domPurchaseRegion(root).children[0] ?? assert.fail("DOM shop link is missing");
}

function domPriceRegion(root: AxNode): AxNode {
  return domPurchaseRegion(root).children[2] ?? assert.fail("DOM price region is missing");
}

function domDimension(root: AxNode): AxNode {
  return domPurchaseRegion(root).children[6] ?? assert.fail("DOM dimension is missing");
}

function domOption(root: AxNode, optionIndex: number): AxNode {
  return domDimension(root).children[1]?.children[optionIndex] ?? assert.fail("DOM option is missing");
}

function applyCurrentDetailDomProfile(root: AxNode): void {
  const region = domPurchaseRegion(root);
  const shopLink = domShopLink(root);
  shopLink.title = null;
  shopLink.children = [
    axNode([...shopLink.path, 0], {
      domClassList: ["shopName--fixture"],
      children: [staticText([...shopLink.path, 0, 0], "Example Audio A", "店铺名称")]
    }),
    staticText([...shopLink.path, 1], "4.2 90天新增73条好评", "店铺指标")
  ];
  const title = region.children[1] ?? assert.fail("DOM title is missing");
  region.children[1] = axNode(title.path, {
    domClassList: ["MainTitle--fixture"],
    children: [axNode([...title.path, 0], {
      domClassList: ["mainTitle--fixture"],
      children: [title]
    })]
  });
  domPriceRegion(root).domClassList = ["priceWrap--fixture"];
  const dimension = domDimension(root);
  const label = dimension.children[0] ?? assert.fail("dimension label is missing");
  const optionList = dimension.children[1] ?? assert.fail("option list is missing");
  optionList.children.forEach((option, index) => {
    const optionLabel = option.children[0] ?? assert.fail("option label is missing");
    option.children = [
      axNode([...option.path, 0], {
        role: "AXImage",
        value: `/fixture-${index}.png`
      }),
      axNode([...option.path, 1], {
        domClassList: ["valueItemText--fixture"],
        children: [optionLabel]
      }),
      ...(index === 0 ? [axNode([...option.path, 2], {
        domClassList: ["cornerText--fixture"],
        children: [staticText([...option.path, 2, 0], "推荐", "角标")]
      })] : [])
    ];
  });
  dimension.domClassList = ["root--fixture"];
  dimension.children = [
    label,
    axNode([...dimension.path, 1], {
      domClassList: ["skuValueWrap--fixture"],
      children: [axNode([...dimension.path, 1, 0], {
        domClassList: ["contentWrap--fixture"],
        children: [optionList]
      }), axNode([...dimension.path, 1, 1], {
        domClassList: ["moreValueItemTipWrap--fixture"],
        children: [staticText([...dimension.path, 1, 1, 0], "查看全部", "更多规格")]
      })]
    })
  ];
  const purchase = region.children[8] ?? assert.fail("purchase button is missing");
  purchase.title = "领券购买";
  region.children.push(axNode([...region.path, region.children.length], {
    role: "AXLink",
    title: "\ue000",
    url: shopLink.url,
    enabled: true,
    actions: ["AXPress"]
  }));
  repath(region, region.path);
}

function repath(root: AxNode, path: number[]): void {
  root.path = path;
  root.children.forEach((child, index) => repath(child, [...path, index]));
}

function withLivePagination(source: AxNode, currentPage: number, totalPages: number): AxNode {
  const root = structuredClone(source);
  const area = searchArea(root);
  const path = [...area.path, area.children.length];
  area.children.push(axNode(path, {
    domClassList: ["next-pagination-pages"],
    children: [
      axNode([...path, 0], {
        role: "AXButton",
        description: `上一页，当前第${currentPage}页`,
        enabled: currentPage > 1,
        actions: ["AXPress"],
        domClassList: ["next-btn", "next-btn-normal", "next-medium", "next-prev", "next-pagination-item"]
      }),
      axNode([...path, 1], {
        domClassList: ["next-pagination-list"],
        children: [
          axNode([...path, 1, 0], {
            role: "AXButton",
            description: `第${currentPage}页，共${totalPages}页`,
            enabled: true,
            actions: ["AXPress"],
            domClassList: ["next-btn", "next-btn-normal", "next-medium", "next-current", "next-pagination-item"]
          }),
          axNode([...path, 1, 1], {
            role: "AXButton",
            description: `第${currentPage === 1 ? 2 : 1}页，共${totalPages}页`,
            enabled: true,
            actions: ["AXPress"],
            domClassList: ["next-btn", "next-btn-normal", "next-medium", "next-pagination-item"]
          })
        ]
      }),
      axNode([...path, 2], {
        domClassList: ["next-pagination-display"],
        children: [
          staticText([...path, 2, 0], String(currentPage), "当前页"),
          staticText([...path, 2, 1], "/", "分页分隔符"),
          staticText([...path, 2, 2], String(totalPages), "总页数")
        ]
      }),
      axNode([...path, 3], {
        role: "AXButton",
        description: `下一页，当前第${currentPage}页`,
        enabled: currentPage < totalPages,
        actions: ["AXPress"],
        domClassList: ["next-btn", "next-btn-normal", "next-medium", "next-next", "next-pagination-item"]
      })
    ]
  }));
  return root;
}

function paginationGroup(root: AxNode): AxNode {
  return findAxNode(root, (node) => node.domClassList?.includes("next-pagination-pages") === true)
    ?? assert.fail("pagination group is missing");
}

function paginationControl(root: AxNode, className: "next-prev" | "next-next"): AxNode {
  return paginationGroup(root).children.find((node) => node.domClassList?.includes(className) === true)
    ?? assert.fail(`${className} pagination control is missing`);
}

function paginationList(root: AxNode): AxNode {
  return findAxNode(root, (node) => node.domClassList?.includes("next-pagination-list") === true)
    ?? assert.fail("pagination list is missing");
}

function currentPaginationButton(root: AxNode): AxNode {
  return paginationList(root).children.find((node) => node.domClassList?.includes("next-current") === true)
    ?? assert.fail("current pagination button is missing");
}

function paginationDisplay(root: AxNode): AxNode {
  return paginationGroup(root).children.find((node) => node.domClassList?.includes("next-pagination-display") === true)
    ?? assert.fail("pagination display is missing");
}

test("reads strict live pagination and chooses page-aware movement actions", async () => {
  const pageOne = withLivePagination(await fixture("live-search-results.json"), 1, 2);
  assert.deepEqual(readSearchPaginationState(pageOne), { currentPage: 1, totalPages: 2 });
  assert.deepEqual(readSearchAdvance(pageOne), {
    kind: "AX_ACTION",
    action: "AXPress",
    node: paginationControl(pageOne, "next-next")
  });
  assert.deepEqual(readSearchRetreat(pageOne), { kind: "KEY", keyCode: 115 });
  assert.equal(hasSearchEndMarker(pageOne), false);

  const pageTwo = withLivePagination(await fixture("live-search-results-next.json"), 2, 2);
  assert.equal(hasSearchEndMarker(pageTwo), true);
  assert.deepEqual(readSearchRetreat(pageTwo), {
    kind: "AX_ACTION",
    action: "AXPress",
    node: paginationControl(pageTwo, "next-prev")
  });
});

test("treats the final strict live pagination page as the search end", async () => {
  const root = withLivePagination(await fixture("live-search-results.json"), 2, 2);

  assert.equal(hasSearchEndMarker(root), true);
});

test("preserves live search fallbacks when strict pagination is absent", async () => {
  const root = await fixture("live-search-results.json");

  assert.equal(readSearchPaginationState(root), null);
  assert.deepEqual(readSearchAdvance(root), { kind: "KEY", keyCode: 121 });
  assert.deepEqual(readSearchRetreat(root), { kind: "KEY", keyCode: 115 });
  assert.equal(hasSearchEndMarker(root), false);
});

test("rejects malformed or ambiguous strict live pagination", async () => {
  const cases: Array<[string, (root: AxNode) => void]> = [
    ["duplicate pagination groups", (root) => {
      const duplicate = structuredClone(paginationGroup(root));
      searchArea(root).children.push(duplicate);
      repath(duplicate, [...searchArea(root).path, searchArea(root).children.length - 1]);
    }],
    ["mismatched display values", (root) => {
      paginationDisplay(root).children[0]!.value = "2";
    }],
    ["disabled next button before the final page", (root) => {
      paginationControl(root, "next-next").enabled = false;
    }],
    ["next button without AXPress", (root) => {
      paginationControl(root, "next-next").actions = [];
    }],
    ["stale next button current-page description", (root) => {
      paginationControl(root, "next-next").description = "下一页，当前第2页";
    }],
    ["missing next-current button", (root) => {
      const current = currentPaginationButton(root);
      current.domClassList = current.domClassList?.filter((value) => value !== "next-current") ?? null;
    }],
    ["duplicate next-current buttons", (root) => {
      const nonCurrent = paginationList(root).children.find((node) =>
        node.domClassList?.includes("next-current") !== true) ?? assert.fail("non-current pagination button is missing");
      nonCurrent.domClassList = [...(nonCurrent.domClassList ?? []), "next-current"];
    }],
    ...["next-btn", "next-btn-normal", "next-medium"].map((className) => [
      `next button without required ${className} class`,
      (root: AxNode) => {
        const control = paginationControl(root, "next-next");
        control.domClassList = control.domClassList?.filter((value) => value !== className) ?? null;
      }
    ] as [string, (root: AxNode) => void])
  ];

  for (const [name, mutate] of cases) {
    const root = withLivePagination(await fixture("live-search-results.json"), 1, 2);
    mutate(root);
    assert.throws(() => readSearchPaginationState(root), UiContractChangedError, name);
  }
});

test("reads the unique live search field and query", async () => {
  const root = await fixture("live-search-results.json");
  assert.equal(findSearchField(root).description, "请输入搜索文字");
  assert.equal(readSearchResultQuery(root), "Example Interface X1");
  assert.equal(findSearchResultContainer(root).role, "AXWebArea");
});

test("finds the unique enabled pressable live search button", async () => {
  const button = liveFindSearchSubmitButton(await fixture("live-search-results.json"));

  assert.equal(button.role, "AXButton");
  assert.equal(button.title, "搜索");
  assert.equal(button.enabled, true);
  assert.equal(button.actions.includes("AXPress"), true);
});

test("rejects unsafe live search submit button candidates", async () => {
  const cases: Array<[string, (root: AxNode) => void]> = [
    ["duplicate", (root) => {
      const button = findAxNode(root, (node) => node.role === "AXButton" && node.title === "搜索");
      assert.ok(button);
      searchArea(root).children[0]?.children.push({ ...structuredClone(button), path: [0, 0, 0, 2] });
    }],
    ["disabled", (root) => {
      const button = findAxNode(root, (node) => node.role === "AXButton" && node.title === "搜索");
      assert.ok(button);
      button.enabled = false;
    }],
    ["non-button", (root) => {
      const button = findAxNode(root, (node) => node.role === "AXButton" && node.title === "搜索");
      assert.ok(button);
      button.role = "AXLink";
    }],
    ["non-pressable", (root) => {
      const button = findAxNode(root, (node) => node.role === "AXButton" && node.title === "搜索");
      assert.ok(button);
      button.actions = ["AXConfirm"];
    }]
  ];

  for (const [name, mutate] of cases) {
    const root = structuredClone(await fixture("live-search-results.json"));
    mutate(root);
    assert.throws(() => liveFindSearchSubmitButton(root), UiContractChangedError, name);
  }
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

test("uses enclosing card evidence when supported item links are nested", async () => {
  const root = structuredClone(await fixture("live-search-results.json"));
  const scope = firstCardScope(root);
  const [firstItemLink, secondItemLink, ...evidence] = scope.children;
  assert.ok(firstItemLink);
  assert.ok(secondItemLink);
  scope.children = [
    axNode([...scope.path, 0], {
      children: [
        { ...firstItemLink, path: [...scope.path, 0, 0] },
        { ...secondItemLink, path: [...scope.path, 0, 1] }
      ]
    }),
    ...evidence.map((node, index) => ({ ...node, path: [...scope.path, index + 1] }))
  ];

  assert.equal(readSearchCards(root)[0]?.shopName, "Example Audio A");
});

test("combines a strict one-digit split-price tail", async () => {
  const root = structuredClone(await fixture("live-search-results.json"));
  replaceFirstCardPriceWithSplit(root);

  const card = readSearchCards(root)[0];
  assert.equal(card?.displayPriceMinText, "4999.90");
  assert.equal(card?.displayPriceMaxText, "4999.90");
});

test("preserves a strict two-digit split-price tail", async () => {
  const root = structuredClone(await fixture("live-search-results.json"));
  replaceFirstCardPriceWithSplit(root, { fraction: "95" });

  const card = readSearchCards(root)[0];
  assert.equal(card?.displayPriceMinText, "4999.95");
  assert.equal(card?.displayPriceMaxText, "4999.95");
});

test("prefers the live price wrapper over numeric product attributes", async () => {
  const root = structuredClone(await fixture("live-search-results.json"));
  replaceFirstCardPriceWithDom(root, { major: "11000", extraNumericText: "2" });

  const card = readSearchCards(root)[0];
  assert.equal(card?.displayPriceMinText, "11000.00");
  assert.equal(card?.displayPriceMaxText, "11000.00");
});

test("reads a dot-prefixed live price fraction from the price wrapper", async () => {
  const root = structuredClone(await fixture("live-search-results.json"));
  replaceFirstCardPriceWithDom(root, { major: "7198", fraction: ".8" });

  const card = readSearchCards(root)[0];
  assert.equal(card?.displayPriceMinText, "7198.80");
  assert.equal(card?.displayPriceMaxText, "7198.80");
});

test("rejects unsupported split-price accessibility shapes", async () => {
  const cases: Array<[string, SplitPriceOptions]> = [
    ["missing currency", { currencyCount: 0 }],
    ["multiple currencies", { currencyCount: 2 }],
    ["missing major position", { majorPosition: null }],
    ["missing fraction size", { fractionSize: null }],
    ["wrong major role", { majorRole: "AXGroup" }],
    ["wrong fraction role", { fractionRole: "AXLink" }],
    ["reversed layout", { fractionPosition: { x: 110, y: 100 } }],
    ["vertically separated", { fractionPosition: { x: 195, y: 130 } }],
    ["not contained", { fractionPosition: { x: 225, y: 100 } }],
    ["not rightmost", { fractionPosition: { x: 140, y: 100 } }],
    ["major too short", { major: "9", fraction: "5" }],
    ["major too long", { major: "123456789", fraction: "5" }],
    ["fraction too long", { fraction: "123" }],
    ["duplicate major node", { duplicateMajor: true }],
    ["third numeric text", { thirdNumeric: "7" }]
  ];

  for (const [name, options] of cases) {
    const root = structuredClone(await fixture("live-search-results.json"));
    replaceFirstCardPriceWithSplit(root, options);
    assert.throws(() => readSearchCards(root), UiContractChangedError, name);
  }
});

test("rejects a target item that can only borrow evidence from a nested sibling item", async () => {
  const root = structuredClone(await fixture("live-search-results.json"));
  const scope = firstCardScope(root);
  const [targetItemLink, siblingItemLink, shopEvidence, priceEvidence] = scope.children;
  assert.ok(targetItemLink);
  assert.ok(siblingItemLink);
  assert.ok(shopEvidence);
  assert.ok(priceEvidence);
  scope.children = [
    axNode([...scope.path, 0], {
      children: [
        { ...targetItemLink, path: [...scope.path, 0, 0] },
        axNode([...scope.path, 0, 1], {
          children: [
            {
              ...siblingItemLink,
              path: [...scope.path, 0, 1, 0],
              url: "https://detail.tmall.com/item.htm?id=example-x1-b"
            },
            { ...shopEvidence, path: [...scope.path, 0, 1, 1] },
            { ...priceEvidence, path: [...scope.path, 0, 1, 2] }
          ]
        })
      ]
    })
  ];

  assert.throws(() => readSearchCards(root), UiContractChangedError);
});

test("keeps an explicit shop name authoritative over a shop-link fallback", async () => {
  const root = structuredClone(await fixture("live-search-results.json"));
  const scope = firstCardScope(root);
  appendShopLink(
    scope,
    4,
    "Fallback Audio A",
    "https://shop.taobao.com/shop/view_shop.htm?user_number_id=fictional-a"
  );

  assert.equal(readSearchCards(root)[0]?.shopName, "Example Audio A");
});

test("uses one strict shop link when explicit shop evidence is absent", async () => {
  const root = structuredClone(await fixture("live-search-results.json"));
  const scope = firstCardScope(root);
  removeExplicitShopEvidence(scope);
  appendShopLink(
    scope,
    4,
    "Fallback Audio A",
    "https://shop.taobao.com/shop/view_shop.htm?user_number_id=fictional-a"
  );

  assert.equal(readSearchCards(root)[0]?.shopName, "Fallback Audio A");
});

test("ignores disabled, non-pressable, and empty shop-link fallbacks", async () => {
  for (const [name, title, options] of [
    ["disabled", "Fallback Audio A", { enabled: false }],
    ["missing AXPress", "Fallback Audio A", { actions: [] }],
    ["empty text", "", {}]
  ] as const) {
    const root = structuredClone(await fixture("live-search-results.json"));
    const scope = firstCardScope(root);
    removeExplicitShopEvidence(scope);
    appendShopLink(
      scope,
      4,
      title,
      "https://shop.taobao.com/shop/view_shop.htm?user_number_id=fictional-a",
      options
    );

    assert.throws(() => readSearchCards(root), UiContractChangedError, name);
  }
});

test("deduplicates repeated strict shop links with the same name", async () => {
  const root = structuredClone(await fixture("live-search-results.json"));
  const scope = firstCardScope(root);
  removeExplicitShopEvidence(scope);
  appendShopLink(scope, 4, "Fallback Audio A", "https://shop.taobao.com/a");
  appendShopLink(scope, 5, "Fallback Audio A", "https://store.tmall.com/b");

  assert.equal(readSearchCards(root)[0]?.shopName, "Fallback Audio A");
});

test("accepts the explicit shop-name accessibility description", async () => {
  const root = structuredClone(await fixture("live-search-results.json"));
  const shop = walkAxNodes(firstCardScope(root)).find((node) => node.description === "店铺");
  assert.ok(shop);
  shop.description = "店铺名称";

  assert.equal(readSearchCards(root)[0]?.shopName, "Example Audio A");
});

test("rejects a live card with neither explicit shop evidence nor a shop link", async () => {
  const root = structuredClone(await fixture("live-search-results.json"));
  removeExplicitShopEvidence(firstCardScope(root));

  assert.throws(() => readSearchCards(root), UiContractChangedError);
});

test("rejects multiple distinct shop-link fallback names", async () => {
  const root = structuredClone(await fixture("live-search-results.json"));
  const scope = firstCardScope(root);
  removeExplicitShopEvidence(scope);
  appendShopLink(scope, 4, "Fallback Audio A", "https://shop.taobao.com/a");
  appendShopLink(scope, 5, "Fallback Audio B", "https://store.tmall.com/b");

  assert.throws(() => readSearchCards(root), UiContractChangedError);
});

test("rejects invalid shop-link fallback URLs", async () => {
  for (const url of [
    "ftp://shop.taobao.com/a",
    "https://shop.example.com/a",
    "https://shopping.taobao.com/a",
    "https://detail.tmall.com/item.htm?id=example-x1-a"
  ]) {
    const root = structuredClone(await fixture("live-search-results.json"));
    const scope = firstCardScope(root);
    removeExplicitShopEvidence(scope);
    appendShopLink(scope, 4, "Not A Shop", url);

    assert.throws(() => readSearchCards(root), UiContractChangedError, url);
  }
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

test("reads the unique DOM-backed detail identity and SKU dimension", async () => {
  const root = await fixture("live-dom-item-x1-default.json");
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
  assert.equal(detail.shareNode, null);

  const dimensions = readSkuDimensions(root);
  assert.deepEqual(dimensions, [{
    name: "套餐",
    options: [
      { id: "live-sku-001cfeaba2e5d72e5673b495", label: "单机", enabled: true },
      { id: "live-sku-ccf17e6cef84d51cdbd66aa0", label: "麦克风套装", enabled: true }
    ]
  }]);
});

test("reads the current DOM-backed detail profile with scoped title and shop evidence", async () => {
  const root = structuredClone(await fixture("live-dom-item-x1-default.json"));
  applyCurrentDetailDomProfile(root);

  const detail = readDetailPage(root);
  assert.equal(detail.title, "Example Interface X1");
  assert.equal(detail.shopName, "Example Audio A");
  assert.deepEqual(readSelectedLabels(root), { "套餐": "单机" });
});

test("keeps the current DOM-backed detail valid when a SKU is almost sold out", async () => {
  const root = structuredClone(await fixture("live-dom-item-x1-default.json"));
  applyCurrentDetailDomProfile(root);
  const stock = findAxNode(domPurchaseRegion(root), (node) => node.value === "有货")
    ?? assert.fail("stock evidence is missing");
  stock.value = "即将售罄";

  assert.equal(readDetailPage(root).platformItemId, "example-x1-a");
  assert.deepEqual(readSelectedLabels(root), { "套餐": "单机" });
});

test("keeps the current DOM-backed detail valid with one strict undiscounted price", async () => {
  const root = structuredClone(await fixture("live-dom-item-x1-default.json"));
  applyCurrentDetailDomProfile(root);
  const region = domPriceRegion(root);
  region.children = [
    staticText([...region.path, 0], "￥", ""),
    staticText([...region.path, 1], "12200", "")
  ];

  assert.equal(readDetailPage(root).platformItemId, "example-x1-a");
  assert.deepEqual(readSelectedLabels(root), { "套餐": "单机" });
});

test("returns the original DOM-backed option node and reads its unique class selection", async () => {
  const root = await fixture("live-dom-item-x1-default.json");
  const option = findSkuOption(root, "套餐", "麦克风套装");

  assert.strictEqual(option, domOption(root, 1));
  assert.deepEqual(option.path, [0, 0, 0, 6, 1, 1]);
  assert.deepEqual(readSelectedLabels(root), { "套餐": "单机" });
  assert.deepEqual(readSelectedLabels(await fixture("live-dom-item-x1-bundle.json")), {
    "套餐": "麦克风套装"
  });
});

test("rejects ambiguous or incomplete DOM-backed detail contracts", async () => {
  const cases: Array<[string, (root: AxNode) => void]> = [
    ["duplicate detail areas", (root) => {
      root.children[0]?.children.push(structuredClone(detailArea(root)));
    }],
    ["duplicate shop links", (root) => {
      domPurchaseRegion(root).children.push(structuredClone(domShopLink(root)));
    }],
    ["duplicate selected options", (root) => {
      domOption(root, 1).domClassList = ["isSelected--alternate", "valueItem--fixture"];
    }],
    ["missing action buttons", (root) => {
      domPurchaseRegion(root).children = domPurchaseRegion(root).children.slice(0, -2);
    }],
    ["missing option labels", (root) => {
      domOption(root, 0).children = [];
    }],
    ["multiple purchase regions", (root) => {
      detailArea(root).children.push(structuredClone(domPurchaseRegion(root)));
    }]
  ];

  for (const [name, mutate] of cases) {
    const root = structuredClone(await fixture("live-dom-item-x1-default.json"));
    mutate(root);
    assert.throws(() => readDetailPage(root), UiContractChangedError, name);
  }
});

test("rejects independent complete DOM purchase regions at uneven depths", async () => {
  const root = structuredClone(await fixture("live-dom-item-x1-default.json"));
  const nestedRegion = structuredClone(domPurchaseRegion(root));
  repath(nestedRegion, [0, 0, 2, 0]);
  detailArea(root).children.push(axNode([0, 0, 2], { children: [nestedRegion] }));

  assert.throws(() => readDetailPage(root), UiContractChangedError);
});

test("rejects a selected DOM option carrying a disabled class at the detail gate", async () => {
  const root = structuredClone(await fixture("live-dom-item-x1-default.json"));
  domOption(root, 0).domClassList?.push("disabled--fixture");

  assert.throws(() => readDetailPage(root), UiContractChangedError);
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
