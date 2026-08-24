import {
  LoginRequiredError,
  PlatformChallengeError,
  UiContractChangedError,
  type SkuDimension,
  type SkuSelection
} from "../../core/desktop-driver.ts";
import { axNodeText, findAxNode, walkAxNodes, type AxNode } from "./ax-node.ts";

const PROFILE_ERROR = "Taobao Accessibility tree does not match the approved 2.4.5 build 15 profile";

export interface SelectedDetailPage {
  platformItemId: string | null;
  url: string;
  title: string;
  shopName: string;
  shareNode: AxNode | null;
}

export interface SelectedSearchCard {
  rank: number;
  occurrenceIndex: number;
  occurrenceKey: string;
  platformItemId: string | null;
  url: string;
  title: string;
  shopName: string;
  displayPriceMinText: string;
  displayPriceMaxText: string;
  sponsored: boolean;
  actionNode: AxNode;
  cardNode: AxNode;
}

function profileError(): never {
  throw new UiContractChangedError(PROFILE_ERROR);
}

function childByIdentifier(parent: AxNode, identifier: string): AxNode | null {
  return parent.children.find((node) => node.identifier === identifier) ?? null;
}

function requiredText(node: AxNode | null): string {
  const text = node ? axNodeText(node) : null;
  return text ?? profileError();
}

export function canonicalItemIdentity(rawUrl: string | null): { platformItemId: string | null; url: string } {
  if (!rawUrl) return profileError();
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return profileError();
  }
  parsed.hash = "";
  const candidate = parsed.searchParams.get("id")?.trim() ?? "";
  const platformItemId = /^[A-Za-z0-9_-]+$/.test(candidate) ? candidate : null;
  parsed.searchParams.sort();
  return { platformItemId, url: parsed.toString() };
}

export function assertNoStopState(root: AxNode): void {
  const login = findAxNode(root, (node) => node.identifier === "login-required-dialog"
    && node.role === "AXWindow" && node.subrole === "AXDialog");
  if (login) throw new LoginRequiredError("Taobao login is required.");

  const challenge = findAxNode(root, (node) => node.identifier === "platform-challenge-dialog"
    && node.role === "AXWindow" && node.subrole === "AXDialog");
  if (challenge) throw new PlatformChallengeError("Taobao platform challenge requires manual handling.");
}

export function findSearchField(root: AxNode): AxNode {
  assertNoStopState(root);
  const region = findAxNode(root, (node) => node.identifier === "search-region"
    && node.role === "AXGroup" && node.title === "商品搜索");
  if (!region) return profileError();
  const fields = walkAxNodes(region).filter((node) => node.role === "AXTextField"
    && (node.subrole === "AXSearchField" || node.description === "搜索商品")
    && node.enabled !== false);
  if (fields.length !== 1) return profileError();
  return fields[0] ?? profileError();
}

export function findSearchResultContainer(root: AxNode): AxNode {
  assertNoStopState(root);
  return findAxNode(root, (node) => node.identifier === "search-result-list"
    && node.role === "AXScrollArea" && node.title === "商品搜索结果") ?? profileError();
}

export function readSearchResultQuery(root: AxNode): string {
  const container = findSearchResultContainer(root);
  const markers = container.children.filter((node) => node.identifier === "search-result-query-marker"
    && node.role === "AXStaticText" && node.description === "结果查询");
  if (markers.length !== 1) return profileError();
  return requiredText(markers[0] ?? null);
}

function readPriceRange(card: AxNode): [string, string] {
  const text = requiredText(childByIdentifier(card, "price-range"));
  const match = /^\s*[¥￥]?\s*(\d+(?:\.\d{1,2})?)(?:\s*[-–—至]\s*[¥￥]?\s*(\d+(?:\.\d{1,2})?))?\s*$/.exec(text);
  if (!match?.[1]) return profileError();
  const min = Number(match[1]).toFixed(2);
  const max = Number(match[2] ?? match[1]).toFixed(2);
  return [min, max];
}

export function readSearchCards(root: AxNode): SelectedSearchCard[] {
  const container = findSearchResultContainer(root);
  const cards = container.children.filter((node) => node.identifier === "result-card"
    && node.role === "AXGroup" && node.title === "商品结果");
  const occurrences = new Map<string, number>();
  return cards.map((cardNode, index) => {
    const actionNode = cardNode.children.find((node) => node.identifier === "item-link"
      && node.role === "AXLink" && node.actions.includes("AXPress"));
    if (!actionNode) return profileError();
    const identity = canonicalItemIdentity(actionNode.url);
    const [displayPriceMinText, displayPriceMaxText] = readPriceRange(cardNode);
    const title = requiredText(actionNode);
    const shopName = requiredText(childByIdentifier(cardNode, "shop-name"));
    const sponsored = childByIdentifier(cardNode, "sponsored-label") !== null;
    const contentKey = JSON.stringify([
      identity.platformItemId,
      identity.url,
      title,
      shopName,
      displayPriceMinText,
      displayPriceMaxText,
      sponsored
    ]);
    const occurrenceIndex = (occurrences.get(contentKey) ?? 0) + 1;
    occurrences.set(contentKey, occurrenceIndex);
    return {
      rank: index + 1,
      occurrenceIndex,
      occurrenceKey: JSON.stringify([cardNode.path, actionNode.path, occurrenceIndex]),
      platformItemId: identity.platformItemId,
      url: identity.url,
      title,
      shopName,
      displayPriceMinText,
      displayPriceMaxText,
      sponsored,
      actionNode,
      cardNode
    };
  });
}

export function hasSearchEndMarker(root: AxNode): boolean {
  const container = findSearchResultContainer(root);
  return container.children.some((node) => node.identifier === "search-end-marker"
    && axNodeText(node) === "已到底");
}

export function readDetailPage(root: AxNode): SelectedDetailPage {
  assertNoStopState(root);
  const detailWindow = findAxNode(root, (node) => node.identifier === "item-detail-window"
    && node.role === "AXWindow" && node.title === "商品详情");
  const header = detailWindow ? childByIdentifier(detailWindow, "item-header") : null;
  if (!detailWindow || !header || header.role !== "AXGroup") return profileError();
  const identity = canonicalItemIdentity(detailWindow.url);
  return {
    ...identity,
    title: requiredText(childByIdentifier(header, "item-title")),
    shopName: requiredText(childByIdentifier(header, "shop-name")),
    shareNode: childByIdentifier(header, "copy-item-link")
  };
}

export function readSkuDimensions(root: AxNode): SkuDimension[] {
  assertNoStopState(root);
  const region = findAxNode(root, (node) => node.identifier === "sku-region"
    && node.role === "AXGroup" && node.title === "规格选择");
  if (!region) return profileError();
  return region.children.filter((node) => node.identifier === "sku-dimension"
    && node.role === "AXGroup" && node.description === "规格维度").map((dimension) => ({
      name: requiredText(dimension),
      options: dimension.children.filter((node) => node.description === "规格选项"
        && ["AXRadioButton", "AXButton"].includes(node.role ?? "")).map((option) => ({
          id: option.identifier ?? profileError(),
          label: requiredText(option),
          enabled: option.enabled !== false
        }))
    }));
}

export function readSelectedLabels(root: AxNode): SkuSelection {
  const dimensions = readSkuDimensions(root);
  const result: SkuSelection = {};
  const region = findAxNode(root, (node) => node.identifier === "sku-region") ?? profileError();
  for (const dimension of dimensions) {
    const dimensionNode = region.children.find((node) => node.identifier === "sku-dimension"
      && axNodeText(node) === dimension.name) ?? profileError();
    const selected = dimensionNode.children.filter((node) => node.selected === true
      && node.description === "规格选项");
    if (selected.length !== 1) return profileError();
    result[dimension.name] = requiredText(selected[0] ?? null);
  }
  return result;
}

export function findSkuOption(root: AxNode, dimensionName: string, label: string): AxNode {
  const region = findAxNode(root, (node) => node.identifier === "sku-region") ?? profileError();
  const dimension = region.children.find((node) => node.identifier === "sku-dimension"
    && axNodeText(node) === dimensionName) ?? profileError();
  const matches = dimension.children.filter((node) => node.description === "规格选项"
    && axNodeText(node) === label);
  if (matches.length !== 1) return profileError();
  return matches[0] ?? profileError();
}

export function findBackAction(root: AxNode): AxNode {
  assertNoStopState(root);
  return findAxNode(root, (node) => node.identifier === "navigation-back"
    && node.role === "AXButton" && node.title === "返回" && node.actions.includes("AXPress")) ?? profileError();
}
