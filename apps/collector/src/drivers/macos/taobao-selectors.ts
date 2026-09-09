import {
  LoginRequiredError,
  PlatformChallengeError,
  UiContractChangedError,
  type SkuDimension,
  type SkuSelection
} from "../../core/desktop-driver.ts";
import { axNodeText, findAxNode, walkAxNodes, type AxNode } from "./ax-node.ts";
import {
  liveAssertNoStopState,
  liveFindBackAction,
  liveFindClipboardLinkPromptDismissAction,
  liveFindSearchField,
  liveFindSearchSubmitButton,
  liveFindSearchResultContainer,
  liveFindSkuOption,
  liveHasSearchEndMarker,
  liveReadDetailPage,
  liveReadSearchAdvance,
  liveReadSearchCards,
  liveReadSearchPaginationState,
  liveReadSearchResultQuery,
  liveReadSearchRetreat,
  liveReadSelectedLabels,
  liveReadSkuDimensions
} from "./taobao-live-selectors.ts";
import type {
  SearchAdvance,
  SearchPaginationState,
  SearchRetreat,
  SelectedDetailPage,
  SelectedSearchCard
} from "./taobao-selector-contract.ts";
import { taobaoSelectorProfile } from "./taobao-selector-profile.ts";
import { canonicalItemIdentity } from "./taobao-url.ts";

export type {
  SearchAdvance,
  SearchPaginationState,
  SearchRetreat,
  SelectedDetailPage,
  SelectedSearchCard
} from "./taobao-selector-contract.ts";
export { canonicalItemIdentity } from "./taobao-url.ts";

const PROFILE_ERROR = "Taobao Accessibility tree does not match the approved 2.4.5 build 15 profile";

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

function syntheticAssertNoStopState(root: AxNode): void {
  const login = findAxNode(root, (node) => node.identifier === "login-required-dialog"
    && node.role === "AXWindow" && node.subrole === "AXDialog");
  if (login) throw new LoginRequiredError("Taobao login is required.");

  const challenge = findAxNode(root, (node) => node.identifier === "platform-challenge-dialog"
    && node.role === "AXWindow" && node.subrole === "AXDialog");
  if (challenge) throw new PlatformChallengeError("Taobao platform challenge requires manual handling.");
}

export function assertNoStopState(root: AxNode): void {
  syntheticAssertNoStopState(root);
  liveAssertNoStopState(root);
}

function syntheticFindSearchField(root: AxNode): AxNode {
  const region = findAxNode(root, (node) => node.identifier === "search-region"
    && node.role === "AXGroup" && node.title === "商品搜索");
  if (!region) return profileError();
  const fields = walkAxNodes(region).filter((node) => node.role === "AXTextField"
    && (node.subrole === "AXSearchField" || node.description === "搜索商品")
    && node.enabled !== false);
  if (fields.length !== 1) return profileError();
  return fields[0] ?? profileError();
}

export function findSearchField(root: AxNode): AxNode {
  assertNoStopState(root);
  return taobaoSelectorProfile(root) === "SYNTHETIC" ? syntheticFindSearchField(root) : liveFindSearchField(root);
}

export function findClipboardLinkPromptDismissAction(root: AxNode): AxNode | null {
  assertNoStopState(root);
  return liveFindClipboardLinkPromptDismissAction(root);
}

export interface SyntheticSearchConfirmAction {
  node: AxNode;
  action: "AXConfirm";
}

export interface SearchSubmitAction {
  node: AxNode;
  action: "AXConfirm" | "AXPress";
}

export function findSyntheticSearchConfirmAction(root: AxNode): SyntheticSearchConfirmAction {
  assertNoStopState(root);
  if (taobaoSelectorProfile(root) !== "SYNTHETIC") return profileError();
  const field = syntheticFindSearchField(root);
  if (field.enabled !== true || !field.actions.includes("AXConfirm")) return profileError();
  return { node: field, action: "AXConfirm" };
}

export function findSearchSubmitAction(root: AxNode): SearchSubmitAction {
  assertNoStopState(root);
  if (taobaoSelectorProfile(root) === "SYNTHETIC") return findSyntheticSearchConfirmAction(root);
  return { node: liveFindSearchSubmitButton(root), action: "AXPress" };
}

function syntheticFindSearchResultContainer(root: AxNode): AxNode {
  return findAxNode(root, (node) => node.identifier === "search-result-list"
    && node.role === "AXScrollArea" && node.title === "商品搜索结果") ?? profileError();
}

export function findSearchResultContainer(root: AxNode): AxNode {
  assertNoStopState(root);
  return taobaoSelectorProfile(root) === "SYNTHETIC"
    ? syntheticFindSearchResultContainer(root)
    : liveFindSearchResultContainer(root);
}

function syntheticReadSearchAdvance(root: AxNode): SearchAdvance {
  const container = syntheticFindSearchResultContainer(root);
  if (!container.actions.includes("AXScrollDown")) {
    throw new UiContractChangedError("Taobao search result container is not semantically scrollable.");
  }
  return { kind: "AX_ACTION", action: "AXScrollDown", node: container };
}

export function readSearchAdvance(root: AxNode): SearchAdvance {
  assertNoStopState(root);
  return taobaoSelectorProfile(root) === "SYNTHETIC"
    ? syntheticReadSearchAdvance(root)
    : liveReadSearchAdvance(root);
}

export function readSearchPaginationState(root: AxNode): SearchPaginationState | null {
  assertNoStopState(root);
  return taobaoSelectorProfile(root) === "SYNTHETIC" ? null : liveReadSearchPaginationState(root);
}

export function readSearchRetreat(root: AxNode): SearchRetreat {
  assertNoStopState(root);
  return taobaoSelectorProfile(root) === "SYNTHETIC"
    ? { kind: "KEY", keyCode: 115 }
    : liveReadSearchRetreat(root);
}

function syntheticReadSearchResultQuery(root: AxNode): string {
  const container = syntheticFindSearchResultContainer(root);
  const markers = container.children.filter((node) => node.identifier === "search-result-query-marker"
    && node.role === "AXStaticText" && node.description === "结果查询");
  if (markers.length !== 1) return profileError();
  return requiredText(markers[0] ?? null);
}

export function readSearchResultQuery(root: AxNode): string {
  assertNoStopState(root);
  return taobaoSelectorProfile(root) === "SYNTHETIC"
    ? syntheticReadSearchResultQuery(root)
    : liveReadSearchResultQuery(root);
}

function readPriceRange(card: AxNode): [string, string] {
  const text = requiredText(childByIdentifier(card, "price-range"));
  const match = /^\s*[¥￥]?\s*(\d+(?:\.\d{1,2})?)(?:\s*[-–—至]\s*[¥￥]?\s*(\d+(?:\.\d{1,2})?))?\s*$/.exec(text);
  if (!match?.[1]) return profileError();
  const min = Number(match[1]).toFixed(2);
  const max = Number(match[2] ?? match[1]).toFixed(2);
  return [min, max];
}

function syntheticReadSearchCards(root: AxNode): SelectedSearchCard[] {
  const container = syntheticFindSearchResultContainer(root);
  const cards = container.children.filter((node) => node.identifier === "result-card"
    && node.role === "AXGroup" && node.title === "商品结果");
  return cards.map((cardNode, index) => {
    const actionNode = cardNode.children.find((node) => node.identifier === "item-link"
      && node.role === "AXLink" && node.actions.includes("AXPress"));
    if (!actionNode) return profileError();
    const identity = canonicalItemIdentity(actionNode.url);
    const [displayPriceMinText, displayPriceMaxText] = readPriceRange(cardNode);
    const title = requiredText(actionNode);
    const shopName = requiredText(childByIdentifier(cardNode, "shop-name"));
    const sponsored = childByIdentifier(cardNode, "sponsored-label") !== null;
    return {
      rank: index + 1,
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

export function readSearchCards(root: AxNode): SelectedSearchCard[] {
  assertNoStopState(root);
  return taobaoSelectorProfile(root) === "SYNTHETIC" ? syntheticReadSearchCards(root) : liveReadSearchCards(root);
}

function syntheticHasSearchEndMarker(root: AxNode): boolean {
  const container = syntheticFindSearchResultContainer(root);
  return container.children.some((node) => node.identifier === "search-end-marker"
    && axNodeText(node) === "已到底");
}

export function hasSearchEndMarker(root: AxNode): boolean {
  assertNoStopState(root);
  return taobaoSelectorProfile(root) === "SYNTHETIC"
    ? syntheticHasSearchEndMarker(root)
    : liveHasSearchEndMarker(root);
}

function syntheticReadDetailPage(root: AxNode): SelectedDetailPage {
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

export function readDetailPage(root: AxNode): SelectedDetailPage {
  assertNoStopState(root);
  return taobaoSelectorProfile(root) === "SYNTHETIC" ? syntheticReadDetailPage(root) : liveReadDetailPage(root);
}

function syntheticReadSkuDimensions(root: AxNode): SkuDimension[] {
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

export function readSkuDimensions(root: AxNode): SkuDimension[] {
  assertNoStopState(root);
  return taobaoSelectorProfile(root) === "SYNTHETIC" ? syntheticReadSkuDimensions(root) : liveReadSkuDimensions(root);
}

function syntheticReadSelectedLabels(root: AxNode): SkuSelection {
  const dimensions = syntheticReadSkuDimensions(root);
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

export function readSelectedLabels(root: AxNode): SkuSelection {
  assertNoStopState(root);
  return taobaoSelectorProfile(root) === "SYNTHETIC"
    ? syntheticReadSelectedLabels(root)
    : liveReadSelectedLabels(root);
}

function syntheticFindSkuOption(root: AxNode, dimensionName: string, label: string): AxNode {
  const region = findAxNode(root, (node) => node.identifier === "sku-region") ?? profileError();
  const dimension = region.children.find((node) => node.identifier === "sku-dimension"
    && axNodeText(node) === dimensionName) ?? profileError();
  const matches = dimension.children.filter((node) => node.description === "规格选项"
    && axNodeText(node) === label);
  if (matches.length !== 1) return profileError();
  return matches[0] ?? profileError();
}

export function findSkuOption(root: AxNode, dimensionName: string, label: string): AxNode {
  return taobaoSelectorProfile(root) === "SYNTHETIC"
    ? syntheticFindSkuOption(root, dimensionName, label)
    : liveFindSkuOption(root, dimensionName, label);
}

function syntheticFindBackAction(root: AxNode): AxNode {
  return findAxNode(root, (node) => node.identifier === "navigation-back"
    && node.role === "AXButton" && node.title === "返回" && node.actions.includes("AXPress")) ?? profileError();
}

export function findBackAction(root: AxNode, exactQuery?: string): AxNode {
  assertNoStopState(root);
  return exactQuery === undefined || taobaoSelectorProfile(root) === "SYNTHETIC"
    ? syntheticFindBackAction(root)
    : liveFindBackAction(root, exactQuery);
}
