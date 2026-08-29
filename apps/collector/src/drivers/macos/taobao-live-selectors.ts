import { createHash } from "node:crypto";

import {
  LoginRequiredError,
  PlatformChallengeError,
  UiContractChangedError,
  type SkuDimension,
  type SkuSelection
} from "../../core/desktop-driver.ts";
import { axNodeText, walkAxNodes, type AxNode } from "./ax-node.ts";
import type { SearchAdvance, SelectedDetailPage, SelectedSearchCard } from "./taobao-selector-contract.ts";
import { canonicalItemIdentity, parseLiveItemUrl } from "./taobao-url.ts";

const PROFILE_ERROR = "Taobao Accessibility tree does not match the approved 2.4.5 build 15 profile";
const LOGIN_TITLES = new Set(["请登录", "账号登录", "扫码登录"]);
const CHALLENGE_TITLES = new Set(["安全验证", "滑块验证", "请完成验证"]);
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
    && parsed?.hostname.toLowerCase() === "s.taobao.com"
    && parsed.pathname === "/search";
}

function uniqueSearchWebArea(root: AxNode): AxNode {
  const areas = walkAxNodes(root).filter(isSearchWebArea);
  if (areas.length !== 1) return profileError();
  return areas[0] ?? profileError();
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

function distinctText(values: Array<string | null>): string[] {
  return [...new Set(values.filter((value): value is string => value !== null))];
}

function cardEvidence(scope: AxNode): CardEvidence | null {
  const priceTexts = distinctText(walkAxNodes(scope).map((node) => {
    const text = axNodeText(node);
    return text && priceRange(text) ? text : null;
  }));
  const shops = distinctText(walkAxNodes(scope).map((node) =>
    node.description === "店铺" && typeof node.value === "string" && node.value.trim()
      ? node.value.trim()
      : null));
  if (priceTexts.length !== 1 || shops.length !== 1) return null;
  const price = priceRange(priceTexts[0] ?? "");
  if (!price) return null;
  return { price, shopName: shops[0] ?? profileError() };
}

function deepestCardScope(searchArea: AxNode, ancestors: AxNode[]): { cardNode: AxNode; evidence: CardEvidence } {
  const candidates = ancestors.filter((node) => node !== searchArea).reverse();
  for (const candidate of candidates) {
    const evidence = cardEvidence(candidate);
    if (evidence) return { cardNode: candidate, evidence };
  }
  return profileError();
}

interface LiveSkuOption {
  id: string;
  label: string;
  enabled: boolean;
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

const TITLE_DESCRIPTIONS = new Set(["商品标题", "商品名称"]);
const SHOP_DESCRIPTIONS = new Set(["店铺", "店铺名称"]);
const SELECTED_STATE_TEXTS = new Set(["已选", "已选择", "已选中", "selected"]);

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

export function findLivePurchaseRegion(root: AxNode): AxNode {
  const detailArea = uniqueDetailWebArea(root);
  const candidates = walkAxNodes(detailArea).filter(isPurchaseRegion);
  const deepestPathLength = Math.max(...candidates.map((node) => node.path.length));
  const deepest = candidates.filter((node) => node.path.length === deepestPathLength);
  if (deepest.length !== 1) return profileError();
  return deepest[0] ?? profileError();
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

function liveSkuDimensions(root: AxNode): LiveSkuDimension[] {
  const dimensionNodes = findLivePurchaseRegion(root).children.filter(isSkuDimensionCandidate);
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
        node
      };
    });
    return { name, options };
  });
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
  const purchaseRegion = findLivePurchaseRegion(root);
  const title = semanticText(purchaseRegion, TITLE_DESCRIPTIONS);
  const shopName = semanticText(purchaseRegion, SHOP_DESCRIPTIONS);
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
    const selected = options.filter((option) => isSelectedSkuOption(option.node));
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
  return (parsed?.protocol === "http:" || parsed?.protocol === "https:")
    && pattern.test(`${parsed.hostname}${parsed.pathname}`);
}

export function liveAssertNoStopState(root: AxNode): void {
  const scopes = walkAxNodes(root).filter(isScopedState);
  if (scopes.some((node) => hasStateUrl(node, /login/i) || LOGIN_TITLES.has(node.title?.trim() ?? ""))) {
    throw new LoginRequiredError("Taobao login is required.");
  }
  if (scopes.some((node) => hasStateUrl(node, /security|punish/i) || CHALLENGE_TITLES.has(node.title?.trim() ?? ""))) {
    throw new PlatformChallengeError("Taobao platform challenge requires manual handling.");
  }
}

export function liveFindSearchField(root: AxNode): AxNode {
  return liveSearchField(uniqueSearchWebArea(root));
}

export function liveFindSearchResultContainer(root: AxNode): AxNode {
  return uniqueSearchWebArea(root);
}

export function liveReadSearchAdvance(root: AxNode): SearchAdvance {
  const searchArea = uniqueSearchWebArea(root);
  const scrollNode = walkAxNodes(searchArea).find((node) =>
    node.enabled !== false && node.actions.includes("AXScrollDown"));
  return scrollNode
    ? { kind: "AX_ACTION", action: "AXScrollDown", node: scrollNode }
    : { kind: "KEY", keyCode: 121 };
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
    if (actionNode.role !== "AXLink" || !actionNode.actions.includes("AXPress")) continue;
    const scope = deepestCardScope(searchArea, ancestors);
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
  return walkAxNodes(uniqueSearchWebArea(root)).some((node) => {
    const text = axNodeText(node);
    return text !== null && END_MARKERS.has(text);
  });
}

function isLiveNavigationControl(node: AxNode): boolean {
  return (node.role === "AXButton" || node.role === "AXRadioButton")
    && node.enabled !== false
    && node.actions.includes("AXPress");
}

export function liveFindBackAction(root: AxNode, exactQuery: string): AxNode {
  const query = normalizeText(exactQuery);
  if (!query) return profileError();
  const controls = walkAxNodes(root).filter(isLiveNavigationControl);
  const exactMatches = controls.filter((node) => [node.title, typeof node.value === "string" ? node.value : null]
    .some((value) => value !== null && normalizeText(value) === query));
  if (exactMatches.length > 1) return profileError();
  if (exactMatches.length === 1) return exactMatches[0] ?? profileError();

  const backMatches = controls.filter((node) => node.title !== null && normalizeText(node.title) === "返回");
  if (backMatches.length !== 1) return profileError();
  return backMatches[0] ?? profileError();
}
