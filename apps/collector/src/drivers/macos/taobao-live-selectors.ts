import {
  LoginRequiredError,
  PlatformChallengeError,
  UiContractChangedError
} from "../../core/desktop-driver.ts";
import { axNodeText, walkAxNodes, type AxNode } from "./ax-node.ts";
import type { SelectedSearchCard } from "./taobao-selector-contract.ts";
import { parseLiveItemUrl } from "./taobao-url.ts";

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

function isScopedState(node: AxNode): boolean {
  return node.role === "AXWebArea" || (node.role === "AXWindow" && node.subrole === "AXDialog");
}

function hasStateUrl(node: AxNode, pattern: RegExp): boolean {
  const parsed = parseUrl(node.url);
  return parsed !== null && pattern.test(`${parsed.hostname}${parsed.pathname}`);
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

export function liveReadSearchResultQuery(root: AxNode): string {
  const searchArea = uniqueSearchWebArea(root);
  const query = requiredFieldQuery(liveSearchField(searchArea));
  const parsed = parseUrl(searchArea.url) ?? profileError();
  const urlQuery = parsed.searchParams.get("q");
  if (urlQuery !== null && normalizedQuery(query) !== normalizedQuery(urlQuery)) return profileError();
  return query;
}

export function liveReadSearchCards(root: AxNode): SelectedSearchCard[] {
  const searchArea = uniqueSearchWebArea(root);
  const cards: SelectedSearchCard[] = [];
  const seenScopes = new Set<string>();
  for (const { node: actionNode, ancestors } of scopedNodes(searchArea)) {
    if (actionNode.role !== "AXLink" || !actionNode.actions.includes("AXPress")) continue;
    const scope = deepestCardScope(searchArea, ancestors);
    const scopePath = scope.cardNode.path.join(",");
    if (seenScopes.has(scopePath)) continue;
    const item = parseLiveItemUrl(actionNode.url);
    const title = axNodeText(actionNode);
    if (!title) return profileError();
    seenScopes.add(scopePath);
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
