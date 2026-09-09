import { createHash } from "node:crypto";

import {
  LoginRequiredError,
  PlatformChallengeError,
  UiContractChangedError,
  type SkuDimension,
  type SkuSelection
} from "../../core/desktop-driver.ts";
import { axNodeText, hasDomClassPrefix, walkAxNodes, type AxNode } from "./ax-node.ts";
import type {
  SearchAdvance,
  SearchPaginationState,
  SearchRetreat,
  SelectedDetailPage,
  SelectedSearchCard
} from "./taobao-selector-contract.ts";
import { canonicalItemIdentity, isSupportedLiveItemUrl, isSupportedLiveShopUrl, parseLiveItemUrl } from "./taobao-url.ts";

const PROFILE_ERROR = "Taobao Accessibility tree does not match the approved 2.4.5 build 15 profile";
const LOGIN_TITLES = new Set(["请登录", "账号登录", "扫码登录"]);
const LOGIN_ACTION_TITLES = new Set([...LOGIN_TITLES, "立即登录"]);
const CHALLENGE_TITLES = new Set(["安全验证", "滑块验证", "请完成验证"]);
const ACCOUNT_MANAGEMENT_TITLES = new Set(["Account Settings", "账号管理", "登陆"]);
const ACCOUNT_MANAGEMENT_PATH = /\/(?:account-panel|pages)\/loginPop\/index\.html$/i;
const SIGN_OUT_TITLES = new Set(["Sign out", "退出登录"]);
const SWITCH_ACCOUNT_TITLES = new Set(["Switch account", "切换账号"]);
const END_MARKERS = new Set(["没有更多了", "已到底", "已经到底了"]);
const PRICE_PATTERN = /^\s*[¥￥]?\s*(\d+(?:\.\d{1,2})?)(?:\s*[-–—至]\s*[¥￥]?\s*(\d+(?:\.\d{1,2})?))?\s*$/;

interface ScopedNode {
  node: AxNode;
  ancestors: AxNode[];
}

interface CardEvidence {
  price: [string, string];
  shopName: string;
}

interface LiveSearchPagination {
  state: SearchPaginationState;
  previousButton: AxNode;
  nextButton: AxNode;
}

function profileError(): never {
  throw new UiContractChangedError(PROFILE_ERROR);
}

function parseUrl(rawUrl: string | null): URL | null {
  if (!rawUrl) return null;
  try {
    return new URL(rawUrl);
  } catch {
    return null;
  }
}

function isSearchWebArea(node: AxNode): boolean {
  const parsed = parseUrl(node.url);
  return node.role === "AXWebArea"
    && (parsed?.protocol === "http:" || parsed?.protocol === "https:")
    && parsed?.hostname.toLowerCase() === "s.taobao.com"
    && parsed.pathname === "/search";
}

function uniqueSearchWebArea(root: AxNode): AxNode {
  const areas = walkAxNodes(root).filter(isSearchWebArea);
  if (areas.length !== 1) return profileError();
  return areas[0] ?? profileError();
}

function hasDomClass(node: AxNode, className: string): boolean {
  return node.domClassList?.includes(className) === true;
}

function liveSearchPagination(root: AxNode): LiveSearchPagination | null {
  const searchArea = uniqueSearchWebArea(root);
  const groups = walkAxNodes(searchArea).filter((node) => hasDomClass(node, "next-pagination-pages"));
  if (groups.length === 0) return null;
  if (groups.length !== 1) return profileError();
  const group = groups[0] ?? profileError();

  const currentButtons = walkAxNodes(group).slice(1).filter((node) =>
    node.role === "AXButton"
      && node.enabled === true
      && node.actions.includes("AXPress")
      && hasDomClass(node, "next-current")
      && hasDomClass(node, "next-btn")
      && hasDomClass(node, "next-btn-normal")
      && hasDomClass(node, "next-medium")
      && hasDomClass(node, "next-pagination-item"));
  if (currentButtons.length !== 1) return profileError();
  const currentButton = currentButtons[0] ?? profileError();
  const currentMatch = /^第(\d+)页，共(\d+)页$/.exec(currentButton.description ?? "");
  if (!currentMatch?.[1] || !currentMatch[2]) return profileError();
  const current = { currentPage: Number(currentMatch[1]), totalPages: Number(currentMatch[2]) };
  if (!Number.isSafeInteger(current.currentPage)
    || !Number.isSafeInteger(current.totalPages)
    || current.currentPage < 1
    || current.totalPages < current.currentPage) return profileError();

  const displays = walkAxNodes(group).filter((node) => hasDomClass(node, "next-pagination-display"));
  if (displays.length !== 1) return profileError();
  const displayValues = walkAxNodes(displays[0] ?? profileError())
    .slice(1)
    .map(axNodeText)
    .filter((value): value is string => value !== null);
  if (displayValues.length !== 3
    || displayValues[0] !== String(current.currentPage)
    || displayValues[1] !== "/"
    || displayValues[2] !== String(current.totalPages)) return profileError();

  const control = (
    directionClass: "next-prev" | "next-next",
    description: string,
    enabled: boolean
  ): AxNode => {
    const matches = group.children.filter((node) => hasDomClass(node, directionClass));
    if (matches.length !== 1) return profileError();
    const node = matches[0] ?? profileError();
    if (node.role !== "AXButton"
      || !hasDomClass(node, "next-btn")
      || !hasDomClass(node, "next-btn-normal")
      || !hasDomClass(node, "next-medium")
      || !hasDomClass(node, "next-pagination-item")
      || node.description !== description
      || node.enabled !== enabled
      || !node.actions.includes("AXPress")) return profileError();
    return node;
  };

  return {
    state: { currentPage: current.currentPage, totalPages: current.totalPages },
    previousButton: control(
      "next-prev",
      `上一页，当前第${current.currentPage}页`,
      current.currentPage > 1
    ),
    nextButton: control(
      "next-next",
      `下一页，当前第${current.currentPage}页`,
      current.currentPage < current.totalPages
    )
  };
}

function normalizedQuery(value: string): string {
  return normalizeText(value);
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function requiredFieldQuery(field: AxNode): string {
  if (typeof field.value !== "string" || field.value.trim() === "") return profileError();
  return field.value.trim();
}

function liveSearchField(searchArea: AxNode): AxNode {
  const fields = walkAxNodes(searchArea).filter((node) => node.role === "AXTextField"
    && node.description === "请输入搜索文字" && node.enabled !== false);
  if (fields.length !== 1) return profileError();
  return fields[0] ?? profileError();
}

function scopedNodes(root: AxNode): ScopedNode[] {
  const nodes: ScopedNode[] = [];
  const visit = (node: AxNode, ancestors: AxNode[]): void => {
    nodes.push({ node, ancestors });
    node.children.forEach((child) => visit(child, [...ancestors, node]));
  };
  visit(root, []);
  return nodes;
}

function priceRange(text: string): [string, string] | null {
  const match = PRICE_PATTERN.exec(text);
  if (!match?.[1]) return null;
  return [Number(match[1]).toFixed(2), Number(match[2] ?? match[1]).toFixed(2)];
}

interface NumericPriceCandidate {
  text: string;
  nodes: AxNode[];
}

function numericPriceCandidates(nodes: AxNode[]): NumericPriceCandidate[] {
  const grouped = new Map<string, AxNode[]>();
  for (const node of nodes) {
    const text = axNodeText(node);
    if (!text || !priceRange(text)) continue;
    grouped.set(text, [...(grouped.get(text) ?? []), node]);
  }
  return [...grouped].map(([text, groupedNodes]) => ({ text, nodes: groupedNodes }));
}

function containsFrame(outer: AxNode, inner: AxNode): boolean {
  if (!outer.position || !outer.size || !inner.position || !inner.size) return false;
  return inner.position.x >= outer.position.x
    && inner.position.y >= outer.position.y
    && inner.position.x + inner.size.width <= outer.position.x + outer.size.width
    && inner.position.y + inner.size.height <= outer.position.y + outer.size.height;
}

function splitPriceRange(nodes: AxNode[], candidates: NumericPriceCandidate[]): [string, string] | null {
  if (candidates.length !== 2 || candidates.some((candidate) => candidate.nodes.length !== 1)) return null;
  const ordered = [...candidates].sort((left, right) => right.text.length - left.text.length);
  const [majorCandidate, fractionCandidate] = ordered;
  const major = majorCandidate?.nodes[0];
  const fraction = fractionCandidate?.nodes[0];
  if (!majorCandidate || !fractionCandidate || !major || !fraction) return null;
  if (!/^[1-9]\d{1,7}$/.test(majorCandidate.text)
    || !/^\d{1,2}$/.test(fractionCandidate.text)
    || Number(fractionCandidate.text) >= 100
    || majorCandidate.text.length <= fractionCandidate.text.length) return null;
  if (major.role !== "AXStaticText" || fraction.role !== "AXStaticText"
    || major.enabled === false || fraction.enabled === false
    || !major.position || !major.size || !fraction.position || !fraction.size) return null;
  if (fraction.position.x <= major.position.x
    || Math.abs(fraction.position.y - major.position.y) > 20
    || !containsFrame(major, fraction)) return null;
  const fractionCenter = fraction.position.x + fraction.size.width / 2;
  if (fractionCenter < major.position.x + major.size.width * 0.75) return null;
  const currencies = nodes.filter((node) => {
    const text = axNodeText(node);
    return node.enabled !== false && (text === "¥" || text === "￥") && node.position !== null;
  });
  if (currencies.length !== 1) return null;
  const currency = currencies[0];
  if (!currency?.position
    || currency.position.x >= major.position.x
    || Math.abs(currency.position.y - major.position.y) > 20
    || major.position.x - currency.position.x > 120) return null;
  const normalized = Number(
    `${majorCandidate.text}.${fractionCandidate.text.padEnd(2, "0")}`
  ).toFixed(2);
  return [normalized, normalized];
}

interface RecognizedPriceRange {
  recognized: boolean;
  value: [string, string] | null;
}

function semanticCardPriceRange(nodes: AxNode[]): RecognizedPriceRange {
  const priceNodes = nodes.filter((node) => node.description === "价格");
  if (priceNodes.length === 0) return { recognized: false, value: null };
  if (priceNodes.length !== 1) return { recognized: true, value: null };
  return { recognized: true, value: priceRange(axNodeText(priceNodes[0]!) ?? "") };
}

function domCardPriceRange(nodes: AxNode[]): RecognizedPriceRange {
  const wrappers = nodes.filter((node) => hasDomClassPrefix(node, "innerNormalPriceWrapper--"));
  if (wrappers.length === 0) return { recognized: false, value: null };
  if (wrappers.length !== 1) return { recognized: true, value: null };
  const wrapperNodes = walkAxNodes(wrappers[0]!);
  const currencies = wrapperNodes.filter((node) => {
    const text = axNodeText(node);
    return node.role === "AXStaticText" && node.enabled !== false && (text === "¥" || text === "￥");
  });
  const majorGroups = wrapperNodes.filter((node) => hasDomClassPrefix(node, "priceInt--"));
  const fractionGroups = wrapperNodes.filter((node) => hasDomClassPrefix(node, "priceFloat--"));
  if (currencies.length !== 1 || majorGroups.length !== 1 || fractionGroups.length > 1) {
    return { recognized: true, value: null };
  }
  const majorTexts = walkAxNodes(majorGroups[0]!).filter((node) => node.role === "AXStaticText")
    .map(axNodeText).filter((text): text is string => text !== null && /^[1-9]\d{0,7}$/.test(text));
  if (majorTexts.length !== 1) return { recognized: true, value: null };
  let fraction = "00";
  if (fractionGroups.length === 1) {
    const fractionTexts = walkAxNodes(fractionGroups[0]!).filter((node) => node.role === "AXStaticText")
      .map(axNodeText).filter((text): text is string => text !== null && /^\.\d{1,2}$/.test(text));
    if (fractionTexts.length !== 1) return { recognized: true, value: null };
    fraction = fractionTexts[0]!.slice(1).padEnd(2, "0");
  }
  const normalized = `${majorTexts[0]}.${fraction}`;
  return { recognized: true, value: [normalized, normalized] };
}

function cardPriceRange(nodes: AxNode[]): [string, string] | null {
  const semantic = semanticCardPriceRange(nodes);
  const dom = domCardPriceRange(nodes);
  if (semantic.recognized || dom.recognized) {
    if (semantic.recognized && dom.recognized) {
      return semantic.value && dom.value
        && semantic.value[0] === dom.value[0]
        && semantic.value[1] === dom.value[1]
        ? semantic.value
        : null;
    }
    return semantic.recognized ? semantic.value : dom.value;
  }
  const candidates = numericPriceCandidates(nodes);
  if (candidates.length === 1) return priceRange(candidates[0]?.text ?? "");
  return splitPriceRange(nodes, candidates);
}

function distinctText(values: Array<string | null>): string[] {
  return [...new Set(values.filter((value): value is string => value !== null))];
}

const SHOP_DESCRIPTIONS = new Set(["店铺", "店铺名称"]);

function explicitShopNames(nodes: AxNode[]): string[] {
  return distinctText(nodes.map((node) =>
    node.description !== null
      && SHOP_DESCRIPTIONS.has(node.description)
      && typeof node.value === "string"
      && node.value.trim()
      ? node.value.trim()
      : null));
}

function fallbackShopNames(nodes: AxNode[]): string[] {
  return distinctText(nodes.map((node) => {
    if (node.role !== "AXLink"
      || node.enabled === false
      || !node.actions.includes("AXPress")
      || !isSupportedLiveShopUrl(node.url)) return null;
    return axNodeText(node);
  }));
}

function searchShopName(nodes: AxNode[]): string | null {
  const explicit = explicitShopNames(nodes);
  if (explicit.length > 1) return null;
  if (explicit.length === 1) return explicit[0] ?? null;
  const fallback = fallbackShopNames(nodes);
  return fallback.length === 1 ? fallback[0] ?? null : null;
}

function isSupportedLiveItemAction(node: AxNode): boolean {
  return node.role === "AXLink"
    && node.actions.includes("AXPress")
    && isSupportedLiveItemUrl(node.url);
}

function cardEvidenceNodes(scope: AxNode, actionNode: AxNode): AxNode[] {
  const nodes: AxNode[] = [];
  const visit = (node: AxNode): void => {
    nodes.push(node);
    for (const child of node.children) {
      const childNodes = walkAxNodes(child);
      if (!childNodes.includes(actionNode) && childNodes.some(isSupportedLiveItemAction)) continue;
      visit(child);
    }
  };
  visit(scope);
  return nodes;
}

function cardEvidence(scope: AxNode, actionNode: AxNode): CardEvidence | null {
  const nodes = cardEvidenceNodes(scope, actionNode);
  const price = cardPriceRange(nodes);
  const shopName = searchShopName(nodes);
  if (!price || !shopName) return null;
  return { price, shopName };
}

function deepestCardScope(searchArea: AxNode, actionNode: AxNode, ancestors: AxNode[]): { cardNode: AxNode; evidence: CardEvidence } {
  const candidates = ancestors.filter((node) => node !== searchArea).reverse();
  for (const candidate of candidates) {
    const evidence = cardEvidence(candidate, actionNode);
    if (evidence) return { cardNode: candidate, evidence };
  }
  return profileError();
}

interface LiveSkuOption {
  id: string;
  label: string;
  enabled: boolean;
  selected: boolean;
  node: AxNode;
}

interface LiveSkuDimension {
  name: string;
  options: LiveSkuOption[];
}

interface LiveSkuDimensionParts {
  name: string;
  optionNodes: AxNode[];
}

interface LivePurchaseRegion {
  kind: "SEMANTIC" | "DOM";
  node: AxNode;
}

const TITLE_DESCRIPTIONS = new Set(["商品标题", "商品名称"]);
const SELECTED_STATE_TEXTS = new Set(["已选", "已选择", "已选中", "selected"]);
const DOM_CURRENT_PRICE_LABELS = new Set(["店铺优惠后", "活动价", "活动到手价"]);
const DOM_LIST_PRICE_LABELS = new Set(["优惠前", "原价", "划线价"]);
const DOM_PRICE_CLASS_PREFIXES = ["price--", "priceWrap--"] as const;
const DOM_TITLE_CLASS_PREFIXES = ["MainTitle--", "mainTitle--"] as const;
const DOM_STOCK_TEXTS = new Set(["有货", "现货", "库存充足", "即将售罄", "无货", "售罄", "缺货"]);
const DOM_ADD_TO_CART_TEXTS = new Set(["加入购物车", "加购物车"]);
const DOM_PURCHASE_TEXTS = new Set(["立即购买", "领券购买"]);

function uniqueDetailWebArea(root: AxNode): AxNode {
  const areas = walkAxNodes(root).filter((node) => node.role === "AXWebArea" && node.title === "商品详情");
  if (areas.length !== 1) return profileError();
  const area = areas[0] ?? profileError();
  if (parseLiveItemUrl(area.url).sponsored) return profileError();
  return area;
}

function semanticText(scope: AxNode, descriptions: Set<string>): string | null {
  const values = new Set(walkAxNodes(scope).flatMap((node) => {
    if (!node.description || !descriptions.has(node.description)) return [];
    const text = axNodeText(node);
    return text ? [normalizeText(text)] : [];
  }));
  if (values.size !== 1) return null;
  return values.values().next().value ?? null;
}

function isSelectedSkuPriceRegion(node: AxNode): boolean {
  if (node.role !== "AXGroup") return false;
  return [node.title, node.description].some((value) => value !== null && normalizeText(value) === "已选规格价格");
}

function isOptionNode(node: AxNode): boolean {
  return (node.role === "AXButton" || node.role === "AXRadioButton") && axNodeText(node) !== null;
}

function optionGroup(node: AxNode): AxNode | null {
  if (node.role !== "AXGroup" || node.children.length === 0 || !node.children.every(isOptionNode)) return null;
  return node;
}

function liveSkuDimensionParts(node: AxNode): LiveSkuDimensionParts | null {
  if (node.role !== "AXGroup" || node.children.length !== 2) return null;
  const label = node.children[0];
  const group = node.children[1];
  const name = label ? axNodeText(label) : null;
  if (!name || !group || optionGroup(group) === null) return null;
  if (walkAxNodes(node).filter((child) => optionGroup(child) !== null).length !== 1) return null;
  return { name: normalizeText(name), optionNodes: group.children };
}

function isSkuDimensionCandidate(node: AxNode): boolean {
  return node.role === "AXGroup"
    && axNodeText(node.children[0] ?? node) !== null
    && node.children.slice(1).some((child) => child.role === "AXGroup");
}

function isPurchaseRegion(node: AxNode): boolean {
  if (node.role !== "AXGroup") return false;
  return semanticText(node, TITLE_DESCRIPTIONS) !== null
    && semanticText(node, SHOP_DESCRIPTIONS) !== null
    && walkAxNodes(node).filter(isSelectedSkuPriceRegion).length === 1
    && node.children.some((child) => liveSkuDimensionParts(child) !== null);
}

function uniqueDeepestRegion(candidates: AxNode[]): AxNode {
  const deepestPathLength = Math.max(...candidates.map((node) => node.path.length));
  const deepest = candidates.filter((node) => node.path.length === deepestPathLength);
  if (deepest.length !== 1) return profileError();
  return deepest[0] ?? profileError();
}

function uniqueIndependentRegion(candidates: AxNode[]): AxNode {
  const innermost = candidates.filter((candidate) => !candidates.some((other) =>
    other !== candidate && walkAxNodes(candidate).includes(other)));
  if (innermost.length !== 1) return profileError();
  return innermost[0] ?? profileError();
}

function semanticPurchaseRegion(detailArea: AxNode): AxNode | null {
  const candidates = walkAxNodes(detailArea).filter(isPurchaseRegion);
  return candidates.length === 0 ? null : uniqueDeepestRegion(candidates);
}

function uniqueSubtreeText(root: AxNode, descendantsOnly = false): string | null {
  const nodes = descendantsOnly ? walkAxNodes(root).slice(1) : walkAxNodes(root);
  const texts = nodes.flatMap((node) => {
    const text = axNodeText(node);
    return text ? [normalizeText(text)] : [];
  });
  return texts.length === 1 ? texts[0] ?? null : null;
}

function hasUniqueClassPrefix(node: AxNode, prefix: string): boolean {
  if (!Array.isArray(node.domClassList)
    || new Set(node.domClassList).size !== node.domClassList.length) return false;
  return node.domClassList.filter((className) => className.startsWith(prefix)).length === 1;
}

function hasUniqueClassFromPrefixes(node: AxNode, prefixes: readonly string[]): boolean {
  if (!Array.isArray(node.domClassList)
    || new Set(node.domClassList).size !== node.domClassList.length) return false;
  return node.domClassList.filter((className) =>
    prefixes.some((prefix) => className.startsWith(prefix))).length === 1;
}

function isDomOptionEnabled(node: AxNode): boolean {
  return node.enabled !== false
    && !(node.domClassList ?? []).some((className) => /disabled|sold.?out|unavailable/i.test(className));
}

function domOptionLabel(node: AxNode): string | null {
  const scopedLabels = new Set(walkAxNodes(node)
    .filter((candidate) => hasUniqueClassPrefix(candidate, "valueItemText--"))
    .flatMap((candidate) => {
      const label = uniqueSubtreeText(candidate);
      return label ? [label] : [];
    }));
  if (scopedLabels.size > 0) {
    return scopedLabels.size === 1 ? scopedLabels.values().next().value ?? null : null;
  }
  return uniqueSubtreeText(node, true);
}

function domOptionList(node: AxNode): AxNode | null {
  if (node.role !== "AXGroup" || node.children.length === 0) return null;
  return node.children.every((option) => option.role === "AXGroup"
    && hasUniqueClassPrefix(option, "valueItem--")
    && domOptionLabel(option) !== null)
    ? node
    : null;
}

function domSkuDimensionParts(node: AxNode): LiveSkuDimensionParts | null {
  if (node.role !== "AXGroup" || node.children.length !== 2) return null;
  const directOptionLists = node.children.filter((child) => domOptionList(child) !== null);
  let optionList: AxNode;
  let labelSubtree: AxNode;
  if (directOptionLists.length === 1) {
    optionList = directOptionLists[0] ?? profileError();
    labelSubtree = node.children.find((child) => child !== optionList) ?? profileError();
  } else {
    if (directOptionLists.length !== 0 || !hasUniqueClassPrefix(node, "root--")) return null;
    const valueBranches = node.children.filter((child) => hasUniqueClassPrefix(child, "skuValueWrap--"));
    if (valueBranches.length !== 1) return null;
    const valueBranch = valueBranches[0] ?? profileError();
    const nestedOptionLists = walkAxNodes(valueBranch).filter((child) => domOptionList(child) !== null);
    if (nestedOptionLists.length !== 1) return null;
    optionList = nestedOptionLists[0] ?? profileError();
    labelSubtree = node.children.find((child) => child !== valueBranch) ?? profileError();
  }
  const name = uniqueSubtreeText(labelSubtree);
  return name ? { name, optionNodes: optionList.children } : null;
}

function domShopName(region: AxNode): string | null {
  const links = walkAxNodes(region).filter((node) => node.role === "AXLink"
    && node.enabled !== false
    && node.actions.includes("AXPress")
    && isSupportedLiveShopUrl(node.url));
  const scopedNames = new Set(links.flatMap((link) =>
    walkAxNodes(link).filter((node) => hasUniqueClassPrefix(node, "shopName--")).flatMap((node) => {
      const name = uniqueSubtreeText(node);
      return name ? [name] : [];
    })));
  if (scopedNames.size > 0) {
    return scopedNames.size === 1 ? scopedNames.values().next().value ?? null : null;
  }
  if (links.length !== 1) return null;
  const directNames = new Set(links.flatMap((link) => {
    const name = axNodeText(link);
    return name ? [normalizeText(name)] : [];
  }));
  return directNames.size === 1 ? directNames.values().next().value ?? null : null;
}

function isDomActionButton(node: AxNode, labels: Set<string>): boolean {
  const text = axNodeText(node);
  return node.role === "AXButton"
    && node.enabled !== false
    && node.actions.includes("AXPress")
    && text !== null
    && labels.has(normalizeText(text));
}

function uniqueDomPriceRegion(region: AxNode): AxNode | null {
  const candidates = walkAxNodes(region).filter((node) =>
    hasUniqueClassFromPrefixes(node, DOM_PRICE_CLASS_PREFIXES));
  if (candidates.length !== 1) return null;
  const priceRegion = candidates[0] ?? profileError();
  const texts = new Set(walkAxNodes(priceRegion).flatMap((node) => {
    const text = axNodeText(node);
    return text ? [normalizeText(text)] : [];
  }));
  const hasLabeledPricePair = [...texts].some((text) => DOM_CURRENT_PRICE_LABELS.has(text))
    && [...texts].some((text) => DOM_LIST_PRICE_LABELS.has(text));
  return hasLabeledPricePair || readLiveDomUndiscountedPriceText(priceRegion) !== null
    ? priceRegion
    : null;
}

export function readLiveDomUndiscountedPriceText(priceRegion: AxNode): string | null {
  if (priceRegion.role !== "AXGroup"
    || priceRegion.enabled === false
    || !hasUniqueClassPrefix(priceRegion, "priceWrap--")
    || priceRegion.children.length !== 2) return null;
  const [currencyNode, amountNode] = priceRegion.children;
  if (!currencyNode || !amountNode
    || currencyNode.role !== "AXStaticText"
    || amountNode.role !== "AXStaticText"
    || currencyNode.enabled === false
    || amountNode.enabled === false
    || currencyNode.children.length !== 0
    || amountNode.children.length !== 0) return null;
  const currency = axNodeText(currencyNode);
  const amount = axNodeText(amountNode);
  return (currency === "¥" || currency === "￥")
    && amount !== null
    && /^(?:0|[1-9]\d{0,7})(?:\.\d{1,2})?$/.test(normalizeText(amount))
    ? normalizeText(amount)
    : null;
}

function domTitle(region: AxNode, priceRegion: AxNode): string | null {
  const scopedTitles = new Set(walkAxNodes(region)
    .filter((node) => hasUniqueClassFromPrefixes(node, DOM_TITLE_CLASS_PREFIXES))
    .flatMap((node) => {
      const title = uniqueSubtreeText(node);
      return title ? [title] : [];
    }));
  if (scopedTitles.size > 0) {
    return scopedTitles.size === 1 ? scopedTitles.values().next().value ?? null : null;
  }
  const ordered = walkAxNodes(region);
  const priceIndex = ordered.indexOf(priceRegion);
  if (priceIndex < 0) return null;
  const candidates = ordered.slice(0, priceIndex).flatMap((node) => {
    if (node.role !== "AXStaticText") return [];
    const text = axNodeText(node);
    return text ? [normalizeText(text)] : [];
  });
  return candidates.length === 1 ? candidates[0] ?? null : null;
}

function domDimensionParts(region: AxNode): LiveSkuDimensionParts[] | null {
  const parts = walkAxNodes(region).flatMap((node) => {
    const dimension = domSkuDimensionParts(node);
    return dimension ? [dimension] : [];
  });
  return parts.length > 0 ? parts : null;
}

function isCompleteDomPurchaseRegion(node: AxNode): boolean {
  if (node.role !== "AXGroup") return false;
  const priceRegion = uniqueDomPriceRegion(node);
  const dimensions = domDimensionParts(node);
  if (!priceRegion || !dimensions || !domShopName(node) || !domTitle(node, priceRegion)) return false;
  const nodes = walkAxNodes(node);
  const stockMarkers = nodes.filter((candidate) => {
    const text = axNodeText(candidate);
    return text !== null && DOM_STOCK_TEXTS.has(normalizeText(text));
  });
  if (stockMarkers.length !== 1
    || nodes.filter((candidate) => isDomActionButton(candidate, DOM_ADD_TO_CART_TEXTS)).length !== 1
    || nodes.filter((candidate) => isDomActionButton(candidate, DOM_PURCHASE_TEXTS)).length !== 1) return false;
  return dimensions.every(({ optionNodes }) => {
    const selected = optionNodes.filter((option) => hasUniqueClassPrefix(option, "isSelected--"));
    const selectedOption = selected[0];
    return selected.length === 1 && selectedOption !== undefined && isDomOptionEnabled(selectedOption);
  });
}

export function resolveLivePurchaseRegion(root: AxNode): LivePurchaseRegion {
  const detailArea = uniqueDetailWebArea(root);
  const semantic = semanticPurchaseRegion(detailArea);
  if (semantic) return { kind: "SEMANTIC", node: semantic };
  const candidates = walkAxNodes(detailArea).filter(isCompleteDomPurchaseRegion);
  return { kind: "DOM", node: uniqueIndependentRegion(candidates) };
}

export function findLivePurchaseRegion(root: AxNode): AxNode {
  return resolveLivePurchaseRegion(root).node;
}

function skuOptionDataId(dimension: string, label: string): string {
  const normalized = `${normalizeText(dimension)}\u0000${normalizeText(label)}`;
  return `live-sku-${createHash("sha256").update(normalized).digest("hex").slice(0, 24)}`;
}

function isSelectedSkuOption(option: AxNode): boolean {
  return option.selected === true
    || option.value === true
    || walkAxNodes(option).slice(1).some((node) => {
      const text = axNodeText(node);
      return text !== null && SELECTED_STATE_TEXTS.has(normalizeText(text).toLowerCase());
    });
}

function semanticSkuDimensions(purchaseRegion: AxNode): LiveSkuDimension[] {
  const dimensionNodes = purchaseRegion.children.filter(isSkuDimensionCandidate);
  if (dimensionNodes.length === 0) return profileError();
  const parts = dimensionNodes.map((node) => liveSkuDimensionParts(node) ?? profileError());

  const dimensionNames = new Set<string>();
  return parts.map(({ name, optionNodes }) => {
    if (dimensionNames.has(name)) return profileError();
    dimensionNames.add(name);

    const labels = new Set<string>();
    const options = optionNodes.map((node) => {
      const label = axNodeText(node);
      if (!label) return profileError();
      const normalizedLabel = normalizeText(label);
      if (labels.has(normalizedLabel)) return profileError();
      labels.add(normalizedLabel);
      if (node.enabled !== false && !node.actions.includes("AXPress")) return profileError();
      return {
        id: skuOptionDataId(name, normalizedLabel),
        label: normalizedLabel,
        enabled: node.enabled !== false,
        selected: isSelectedSkuOption(node),
        node
      };
    });
    return { name, options };
  });
}

function domSkuDimensions(purchaseRegion: AxNode): LiveSkuDimension[] {
  const parts = domDimensionParts(purchaseRegion) ?? profileError();
  const dimensionNames = new Set<string>();
  return parts.map(({ name, optionNodes }) => {
    if (dimensionNames.has(name)) return profileError();
    dimensionNames.add(name);
    const labels = new Set<string>();
    const options = optionNodes.map((node) => {
      const label = domOptionLabel(node);
      if (!label || labels.has(label)) return profileError();
      labels.add(label);
      const enabled = isDomOptionEnabled(node);
      return {
        id: skuOptionDataId(name, label),
        label,
        enabled,
        selected: hasUniqueClassPrefix(node, "isSelected--"),
        node
      };
    });
    if (options.filter((option) => option.selected && option.enabled).length !== 1
      || options.some((option) => option.selected && !option.enabled)) return profileError();
    return { name, options };
  });
}

function liveSkuDimensions(root: AxNode): LiveSkuDimension[] {
  const purchaseRegion = resolveLivePurchaseRegion(root);
  return purchaseRegion.kind === "SEMANTIC"
    ? semanticSkuDimensions(purchaseRegion.node)
    : domSkuDimensions(purchaseRegion.node);
}

function uniqueShareNode(purchaseRegion: AxNode): AxNode | null {
  const shares = walkAxNodes(purchaseRegion).filter((node) => {
    if (!node.actions.includes("AXPress")) return false;
    return [node.title, node.description].some((value) => value !== null && /分享|复制链接|share|copy link/i.test(value));
  });
  if (shares.length > 1) return profileError();
  return shares[0] ?? null;
}

export function liveReadDetailPage(root: AxNode): SelectedDetailPage {
  const detailArea = uniqueDetailWebArea(root);
  const purchase = resolveLivePurchaseRegion(root);
  const purchaseRegion = purchase.node;
  const priceRegion = purchase.kind === "DOM" ? uniqueDomPriceRegion(purchaseRegion) : null;
  const scopedShopName = purchase.kind === "DOM" ? domShopName(purchaseRegion) : null;
  const title = purchase.kind === "SEMANTIC"
    ? semanticText(purchaseRegion, TITLE_DESCRIPTIONS)
    : priceRegion ? domTitle(purchaseRegion, priceRegion) : null;
  const shopName = purchase.kind === "SEMANTIC"
    ? semanticText(purchaseRegion, SHOP_DESCRIPTIONS)
    : scopedShopName;
  if (!title || !shopName) return profileError();
  return {
    ...canonicalItemIdentity(detailArea.url),
    title,
    shopName,
    shareNode: uniqueShareNode(purchaseRegion)
  };
}

export function liveReadSkuDimensions(root: AxNode): SkuDimension[] {
  return liveSkuDimensions(root).map(({ name, options }) => ({
    name,
    options: options.map(({ id, label, enabled }) => ({ id, label, enabled }))
  }));
}

export function liveReadSelectedLabels(root: AxNode): SkuSelection {
  return Object.fromEntries(liveSkuDimensions(root).map(({ name, options }) => {
    const selected = options.filter((option) => option.selected);
    if (selected.length !== 1) return profileError();
    return [name, selected[0]?.label ?? profileError()];
  }));
}

export function liveFindSkuOption(root: AxNode, dimensionName: string, label: string): AxNode {
  const dimension = liveSkuDimensions(root).find((candidate) => candidate.name === normalizeText(dimensionName));
  if (!dimension) return profileError();
  const option = dimension.options.find((candidate) => candidate.label === normalizeText(label));
  return option?.node ?? profileError();
}

function isScopedState(node: AxNode): boolean {
  return node.role === "AXWebArea" || (node.role === "AXWindow" && node.subrole === "AXDialog");
}

function hasStateUrl(node: AxNode, pattern: RegExp): boolean {
  const parsed = parseUrl(node.url);
  return (parsed?.protocol === "http:" || parsed?.protocol === "https:" || parsed?.protocol === "file:")
    && pattern.test(`${parsed.hostname}${parsed.pathname}`);
}

function isConfirmedAccountManagementFrame(node: AxNode): boolean {
  const parsed = parseUrl(node.url);
  if (node.role !== "AXWebArea" || parsed?.protocol !== "file:"
    || !ACCOUNT_MANAGEMENT_PATH.test(parsed.pathname)
    || !ACCOUNT_MANAGEMENT_TITLES.has(node.title?.trim() ?? "")) return false;
  const texts = new Set(walkAxNodes(node).flatMap((candidate) => {
    const text = axNodeText(candidate);
    return text ? [normalizeText(text)] : [];
  }));
  return [...SIGN_OUT_TITLES].some((title) => texts.has(title))
    && [...SWITCH_ACCOUNT_TITLES].some((title) => texts.has(title));
}

function hasConfirmedLoginAction(scope: AxNode): boolean {
  return walkAxNodes(scope).some((node) => {
    const text = axNodeText(node);
    return node.role === "AXButton"
      && node.enabled !== false
      && node.actions.includes("AXPress")
      && text !== null
      && LOGIN_ACTION_TITLES.has(normalizeText(text));
  });
}

export function liveAssertNoStopState(root: AxNode): void {
  const scopes = walkAxNodes(root).filter((node) => isScopedState(node) && !isConfirmedAccountManagementFrame(node));
  if (scopes.some((node) => hasStateUrl(node, /login/i)
    || LOGIN_TITLES.has(node.title?.trim() ?? "")
    || hasConfirmedLoginAction(node))) {
    throw new LoginRequiredError("Taobao login is required.");
  }
  if (scopes.some((node) => hasStateUrl(node, /security|punish/i) || CHALLENGE_TITLES.has(node.title?.trim() ?? ""))) {
    throw new PlatformChallengeError("Taobao platform challenge requires manual handling.");
  }
}

export function liveFindSearchField(root: AxNode): AxNode {
  return liveSearchField(uniqueSearchWebArea(root));
}

export function liveFindClipboardLinkPromptDismissAction(root: AxNode): AxNode | null {
  const dialogs = walkAxNodes(root).filter((node) => node.role === "AXGroup"
    && node.enabled === true
    && hasDomClass(node, "dialog-container")
    && walkAxNodes(node).some((candidate) =>
      candidate.role === "AXStaticText"
      && axNodeText(candidate) === "已经识别到剪贴板中的淘宝链接"));
  if (dialogs.length === 0) return null;
  if (dialogs.length !== 1) return profileError();
  const dialog = dialogs[0] ?? profileError();
  if (dialog.children.length !== 4) return profileError();

  const title = dialog.children.filter((node) => hasDomClassPrefix(node, "_title_")
    && node.children.length === 1
    && node.children[0]?.role === "AXStaticText"
    && axNodeText(node.children[0]) === "已经识别到剪贴板中的淘宝链接");
  const clipboardLink = dialog.children.filter((node) => hasDomClassPrefix(node, "_clipboardLink_")
    && node.children.length === 1
    && node.children[0]?.role === "AXStaticText");
  const clipboardUrl = clipboardLink.length === 1
    ? parseUrl(axNodeText(clipboardLink[0]!.children[0]!) ?? null)
    : null;
  const hostname = clipboardUrl?.hostname.toLowerCase() ?? "";
  const validClipboardUrl = clipboardUrl !== null
    && (clipboardUrl.protocol === "http:" || clipboardUrl.protocol === "https:")
    && (hostname === "taobao.com" || hostname.endsWith(".taobao.com")
      || hostname === "tmall.com" || hostname.endsWith(".tmall.com"));
  const buttons = (classPrefix: "_btnClose_" | "_btnConfirm_", label: string): AxNode[] =>
    dialog.children.filter((node) => node.role === "AXGroup"
      && node.enabled === true
      && node.actions.includes("AXPress")
      && hasDomClassPrefix(node, classPrefix)
      && hasDomClassPrefix(node, "_btn_")
      && node.children.length === 1
      && node.children[0]?.role === "AXStaticText"
      && axNodeText(node.children[0]) === label);
  const dismiss = buttons("_btnClose_", "稍后再说");
  const confirm = buttons("_btnConfirm_", "直接打开");
  if (title.length !== 1 || !validClipboardUrl || dismiss.length !== 1 || confirm.length !== 1) {
    return profileError();
  }
  return dismiss[0] ?? profileError();
}

export function liveFindSearchSubmitButton(root: AxNode): AxNode {
  const candidates = walkAxNodes(uniqueSearchWebArea(root)).filter((node) =>
    node.role === "AXButton" && normalizeText(axNodeText(node) ?? "") === "搜索");
  if (candidates.length !== 1) return profileError();
  const button = candidates[0] ?? profileError();
  if (button.enabled !== true || !button.actions.includes("AXPress")) return profileError();
  return button;
}

export function liveFindSearchResultContainer(root: AxNode): AxNode {
  return uniqueSearchWebArea(root);
}

export function liveReadSearchPaginationState(root: AxNode): SearchPaginationState | null {
  return liveSearchPagination(root)?.state ?? null;
}

export function liveReadSearchAdvance(root: AxNode): SearchAdvance {
  const searchArea = uniqueSearchWebArea(root);
  const pagination = liveSearchPagination(searchArea);
  if (pagination && pagination.state.currentPage < pagination.state.totalPages) {
    return { kind: "AX_ACTION", action: "AXPress", node: pagination.nextButton };
  }
  const scrollNode = walkAxNodes(searchArea).find((node) =>
    node.enabled !== false && node.actions.includes("AXScrollDown"));
  return scrollNode
    ? { kind: "AX_ACTION", action: "AXScrollDown", node: scrollNode }
    : { kind: "KEY", keyCode: 121 };
}

export function liveReadSearchRetreat(root: AxNode): SearchRetreat {
  const pagination = liveSearchPagination(root);
  return pagination && pagination.state.currentPage > 1
    ? { kind: "AX_ACTION", action: "AXPress", node: pagination.previousButton }
    : { kind: "KEY", keyCode: 115 };
}

export function liveReadSearchResultQuery(root: AxNode): string {
  const searchArea = uniqueSearchWebArea(root);
  const query = requiredFieldQuery(liveSearchField(searchArea));
  const parsed = parseUrl(searchArea.url) ?? profileError();
  const urlQueries = parsed.searchParams.getAll("q").map(normalizedQuery);
  const distinctUrlQueries = [...new Set(urlQueries)];
  if (distinctUrlQueries.length > 1) return profileError();
  if (distinctUrlQueries[0] !== undefined && normalizedQuery(query) !== distinctUrlQueries[0]) return profileError();
  return query;
}

export function liveReadSearchCards(root: AxNode): SelectedSearchCard[] {
  const searchArea = uniqueSearchWebArea(root);
  const cards: SelectedSearchCard[] = [];
  const seenScopes = new Map<string, { platformItemId: string | null; url: string }>();
  for (const { node: actionNode, ancestors } of scopedNodes(searchArea)) {
    if (!isSupportedLiveItemAction(actionNode)) continue;
    const scope = deepestCardScope(searchArea, actionNode, ancestors);
    const scopePath = scope.cardNode.path.join(",");
    const item = parseLiveItemUrl(actionNode.url);
    const existing = seenScopes.get(scopePath);
    if (existing) {
      if (existing.platformItemId !== item.platformItemId || existing.url !== item.url) return profileError();
      continue;
    }
    const title = axNodeText(actionNode);
    if (!title) return profileError();
    seenScopes.set(scopePath, item);
    cards.push({
      rank: cards.length + 1,
      platformItemId: item.platformItemId,
      url: item.url,
      title,
      shopName: scope.evidence.shopName,
      displayPriceMinText: scope.evidence.price[0],
      displayPriceMaxText: scope.evidence.price[1],
      sponsored: item.sponsored || walkAxNodes(scope.cardNode).some((node) => axNodeText(node) === "广告"),
      actionNode,
      cardNode: scope.cardNode
    });
  }
  return cards;
}

export function liveHasSearchEndMarker(root: AxNode): boolean {
  const searchArea = uniqueSearchWebArea(root);
  const pagination = liveSearchPagination(searchArea);
  if (pagination && pagination.state.currentPage === pagination.state.totalPages) return true;
  return walkAxNodes(searchArea).some((node) => {
    const text = axNodeText(node);
    return text !== null && END_MARKERS.has(text);
  });
}

function isLiveNavigationControl(node: AxNode): boolean {
  return (node.role === "AXButton" || node.role === "AXRadioButton")
    && node.enabled !== false
    && node.actions.includes("AXPress");
}

function stripPrivateUseAffixes(value: string): string {
  return normalizeText(value
    .replace(/^[\s\uE000-\uF8FF]+/u, "")
    .replace(/[\s\uE000-\uF8FF]+$/u, ""));
}

function currentSearchPageTitle(root: AxNode, query: string): string | null {
  const areas = walkAxNodes(root).filter(isSearchWebArea);
  if (areas.length === 0) return null;
  if (areas.length !== 1) return profileError();
  const area = areas[0] ?? profileError();
  if (normalizeText(liveReadSearchResultQuery(root)) !== query) return profileError();
  const title = typeof area.title === "string" ? normalizeText(area.title) : "";
  return title === `${query}_淘宝搜索` ? title : null;
}

export function liveFindBackAction(root: AxNode, exactQuery: string): AxNode {
  const query = normalizeText(exactQuery);
  if (!query) return profileError();
  const controls = walkAxNodes(root).filter(isLiveNavigationControl);
  const exactMatches = controls.filter((node) => [
    typeof node.title === "string" ? node.title : null,
    typeof node.value === "string" ? node.value : null
  ]
    .some((value) => value !== null && normalizeText(value) === query));
  if (exactMatches.length > 1) return profileError();
  if (exactMatches.length === 1) return exactMatches[0] ?? profileError();

  const searchPageTitle = currentSearchPageTitle(root, query);
  if (searchPageTitle !== null) {
    const decoratedMatches = controls.filter((node) => [
      typeof node.title === "string" ? node.title : null,
      typeof node.value === "string" ? node.value : null
    ].some((value) => value !== null && stripPrivateUseAffixes(value) === searchPageTitle));
    if (decoratedMatches.length > 1) return profileError();
    if (decoratedMatches.length === 1) return decoratedMatches[0] ?? profileError();
  }

  const backMatches = controls.filter((node) => typeof node.title === "string" && normalizeText(node.title) === "返回");
  if (backMatches.length !== 1) return profileError();
  return backMatches[0] ?? profileError();
}
