import { randomUUID } from "node:crypto";
import { join } from "node:path";

import {
  DriverIssueError,
  DriverSkuIssueError,
  UiContractChangedError,
  type DriverDiagnostic,
  type DriverItemPage,
  type DriverSearchPosition,
  type DriverSkuSelectionResult,
  type DriverSkuView,
  type SkuSelection,
  type TaobaoDesktopDriver
} from "../../core/desktop-driver.ts";
import {
  AxHelperClient,
  type AxHelperCommandFields,
  type AxHelperCommandName,
  type AxHelperDiagnosticPayload
} from "./ax-helper-client.ts";
import { fingerprintFor, type AxJsonValue, type AxNode } from "./ax-node.ts";
import { readSelectedSkuEvidence } from "./taobao-price-evidence.ts";
import {
  assertNoStopState,
  canonicalItemIdentity,
  findBackAction,
  findSearchField,
  findSearchResultContainer,
  findSkuOption,
  hasSearchEndMarker,
  readDetailPage,
  readSearchCards,
  readSelectedLabels,
  readSkuDimensions,
  type SelectedSearchCard
} from "./taobao-selectors.ts";

const SUPPORTED_VERSION = "2.4.5";
const SUPPORTED_BUILD = "15";
const POLL_INTERVAL_MS = 250;
const STABILITY_TIMEOUT_MS = 15_000;
const STABLE_OBSERVATION_COUNT = 3;

export interface TaobaoAxClient {
  diagnose(): Promise<AxHelperDiagnosticPayload>;
  snapshot(): Promise<AxNode>;
  command<T = AxJsonValue>(command: AxHelperCommandName, fields?: AxHelperCommandFields): Promise<T>;
}

export interface TaobaoMacDriverOptions {
  client?: TaobaoAxClient;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  capturedAt?: () => string;
  uuid?: () => string;
  workDir?: string;
}

export class AppVersionUnsupportedError extends DriverIssueError {
  constructor(version: string | null, build: string | null) {
    super(
      "APP_VERSION_UNSUPPORTED",
      `Unsupported Taobao Desktop version ${safeObserved(version)} build ${safeObserved(build)}.`
    );
    this.name = "AppVersionUnsupportedError";
  }
}

export class MissingItemIdError extends DriverIssueError {
  constructor() {
    super("MISSING_ITEM_ID", "A stable Taobao item ID was not available.");
    this.name = "MissingItemIdError";
  }
}

export class PriceUnstableError extends DriverSkuIssueError {
  constructor() {
    super("PRICE_UNSTABLE", "Selected-SKU price evidence did not stabilize within 15 seconds.");
    this.name = "PriceUnstableError";
  }
}

function safeObserved(value: string | null): string {
  if (!value) return "unknown";
  const safe = value.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80);
  return safe || "unknown";
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function selectionKey(selection: SkuSelection): string {
  return JSON.stringify(Object.entries(selection).sort(([left], [right]) => left.localeCompare(right)));
}

function sameSelection(left: SkuSelection, right: SkuSelection): boolean {
  return selectionKey(left) === selectionKey(right);
}

function cardKey(card: SelectedSearchCard): string {
  return JSON.stringify([
    card.platformItemId, card.url, card.title, card.shopName,
    card.displayPriceMinText, card.displayPriceMaxText, card.sponsored
  ]);
}

function overlapLength(existing: SelectedSearchCard[], next: SelectedSearchCard[]): number {
  const max = Math.min(existing.length, next.length);
  for (let length = max; length > 0; length -= 1) {
    const suffix = existing.slice(existing.length - length).map(cardKey);
    const prefix = next.slice(0, length).map(cardKey);
    if (suffix.every((value, index) => value === prefix[index])) return length;
  }
  return 0;
}

export class TaobaoMacDriver implements TaobaoDesktopDriver {
  private readonly client: TaobaoAxClient;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly capturedAt: () => string;
  private readonly uuid: () => string;
  private readonly workDir: string | undefined;
  private diagnostic: AxHelperDiagnosticPayload | null = null;
  private currentSearchQuery: string | null = null;
  private currentItemId: string | null = null;

  constructor(options: TaobaoMacDriverOptions = {}) {
    this.client = options.client ?? new AxHelperClient();
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
    this.capturedAt = options.capturedAt ?? (() => new Date().toISOString());
    this.uuid = options.uuid ?? randomUUID;
    this.workDir = options.workDir ?? process.env.COLLECTOR_WORK_DIR;
  }

  async diagnose(): Promise<DriverDiagnostic> {
    const diagnostic = await this.ensureSupported();
    let loginState: DriverDiagnostic["loginState"] = "UNKNOWN";
    if (diagnostic.appRunning && diagnostic.trusted) {
      const root = await this.client.snapshot();
      try {
        assertNoStopState(root);
        loginState = "LOGGED_IN";
      } catch (error) {
        if (error instanceof Error && error.name === "LoginRequiredError") loginState = "LOGGED_OUT";
        else throw error;
      }
    }
    const capturedAt = this.capturedAt();
    return {
      accessibilityTrusted: diagnostic.trusted,
      appRunning: diagnostic.appRunning,
      processId: diagnostic.pid,
      bundleId: diagnostic.bundleId ?? "com.taobao.pcdesktop",
      appVersion: diagnostic.shortVersion,
      appBuild: diagnostic.build,
      hasFrontWindow: diagnostic.frontWindowAvailable,
      loginState,
      rawEvidence: {
        source: "taobao-ax-helper:diagnose",
        capturedAt,
        metadata: {
          approvedProfile: `${SUPPORTED_VERSION}+${SUPPORTED_BUILD}`,
          appRunning: diagnostic.appRunning,
          frontWindowAvailable: diagnostic.frontWindowAvailable
        }
      }
    };
  }

  async openOwnListing(url: string): Promise<DriverItemPage> {
    const expected = canonicalItemIdentity(url);
    if (!expected.platformItemId) throw new MissingItemIdError();
    const positions = await this.search(url, 1);
    const first = positions[0];
    if (!first) throw new UiContractChangedError("Taobao did not expose the requested own listing.");
    const page = await this.openSearchPosition(first);
    if (page.platformItemId !== expected.platformItemId) {
      throw new UiContractChangedError("Taobao opened a different own listing.");
    }
    return page;
  }

  async search(query: string, limit: number): Promise<DriverSearchPosition[]> {
    await this.ensureSupported();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
      throw new TypeError("Search limit must be an integer from 1 through 50");
    }
    const initial = await this.client.snapshot();
    assertNoStopState(initial);
    const field = findSearchField(initial);
    await this.client.command("setValue", {
      nodePath: field.path,
      value: query,
      fingerprint: fingerprintFor(field)
    });
    await this.client.command("keyPress", { keyCode: 36 });

    const firstResult = await this.waitForSearch(query);
    const cards = [...readSearchCards(firstResult)];
    let root = firstResult;
    let scrollCount = 0;
    while (cards.length < limit && !hasSearchEndMarker(root) && scrollCount < 50) {
      const container = findSearchResultContainer(root);
      if (!container.actions.includes("AXScrollDown")) {
        throw new UiContractChangedError("Taobao search result container is not semantically scrollable.");
      }
      await this.client.command("perform", {
        nodePath: container.path,
        action: "AXScrollDown",
        fingerprint: fingerprintFor(container)
      });
      root = await this.waitForSearch(query);
      const next = readSearchCards(root);
      const overlap = overlapLength(cards, next);
      if (overlap === next.length && !hasSearchEndMarker(root)) {
        throw new UiContractChangedError("Taobao search result scrolling made no semantic progress.");
      }
      cards.push(...next.slice(overlap));
      scrollCount += 1;
    }

    this.currentSearchQuery = query;
    const capturedAt = this.capturedAt();
    return cards.slice(0, limit).map((card, index) => ({
      rank: index + 1,
      platformItemId: card.platformItemId,
      url: card.url,
      shopName: card.shopName,
      title: card.title,
      displayPriceMinText: card.displayPriceMinText,
      displayPriceMaxText: card.displayPriceMaxText,
      sponsored: card.sponsored,
      capturedAt,
      rawEvidence: {
        source: "taobao-ax-helper:search-card",
        capturedAt,
        metadata: {
          rank: index + 1,
          nodePath: card.actionNode.path,
          role: card.actionNode.role,
          title: card.actionNode.title,
          identifier: card.actionNode.identifier
        }
      }
    }));
  }

  async openSearchPosition(position: DriverSearchPosition): Promise<DriverItemPage> {
    await this.ensureSupported();
    const root = await this.client.snapshot();
    assertNoStopState(root);
    const card = await this.locateCard(root, position);
    await this.client.command("perform", {
      nodePath: card.actionNode.path,
      action: "AXPress",
      fingerprint: fingerprintFor(card.actionNode)
    });

    const detailRoot = await this.waitForStableDetail();
    let detail = readDetailPage(detailRoot);
    if (!detail.platformItemId && detail.shareNode) {
      const copied = await this.client.command<{ text?: unknown }>("captureCopiedText", {
        nodePath: detail.shareNode.path,
        action: "AXPress",
        fingerprint: fingerprintFor(detail.shareNode)
      });
      const copiedText = typeof copied?.text === "string" ? copied.text : null;
      const identity = canonicalItemIdentity(copiedText);
      if (identity.platformItemId) detail = { ...detail, ...identity };
    }
    if (!detail.platformItemId) throw new MissingItemIdError();
    if (position.platformItemId !== null && detail.platformItemId !== position.platformItemId) {
      throw new UiContractChangedError("Taobao detail item identity changed after opening the result.");
    }
    this.currentItemId = detail.platformItemId;
    const capturedAt = this.capturedAt();
    return {
      platformItemId: detail.platformItemId,
      url: detail.url,
      shopName: detail.shopName,
      title: detail.title,
      skuDimensions: readSkuDimensions(detailRoot),
      rawEvidence: {
        source: "taobao-ax-helper:item-detail",
        capturedAt,
        metadata: { platformItemId: detail.platformItemId }
      }
    };
  }

  async selectSku(selection: SkuSelection): Promise<DriverSkuSelectionResult> {
    await this.ensureSupported();
    let root = await this.client.snapshot();
    assertNoStopState(root);
    for (const [dimensionName, label] of Object.entries(selection)) {
      const option = findSkuOption(root, dimensionName, label);
      if (option.enabled === false) {
        return { availability: "UNAVAILABLE", reason: `SKU option ${label} is disabled` };
      }
      if (!option.actions.includes("AXPress")) {
        throw new UiContractChangedError("Taobao SKU option is not semantically actionable.");
      }
      await this.client.command("perform", {
        nodePath: option.path,
        action: "AXPress",
        fingerprint: fingerprintFor(option)
      });
      root = await this.client.snapshot();
      assertNoStopState(root);
    }

    const stable = await this.waitForStableSku(root);
    const selectedLabels = readSelectedLabels(stable);
    const evidence = readSelectedSkuEvidence(stable);
    if (evidence.stockState === "OUT_OF_STOCK") {
      return { availability: "UNAVAILABLE", reason: "Selected SKU is out of stock" };
    }

    const detail = readDetailPage(stable);
    const itemId = detail.platformItemId ?? this.currentItemId;
    if (!itemId) throw new MissingItemIdError();
    const capturedAt = this.capturedAt();
    const view: DriverSkuView = {
      selectedLabels,
      listPriceText: evidence.listPriceText,
      activityPriceText: evidence.activityPriceText,
      officialEstimatedPayablePriceText: evidence.officialEstimatedPayablePriceText,
      promotions: evidence.promotions,
      mandatoryFeeText: evidence.mandatoryFeeText,
      stockState: evidence.stockState,
      capturedAt,
      rawEvidence: {
        source: "taobao-ax-helper:selected-sku",
        capturedAt,
        metadata: {
          requestedSelection: selectionKey(selection),
          selectedSelection: selectionKey(selectedLabels),
          activityPriceText: evidence.activityPriceText,
          promotionTexts: evidence.promotionTexts
        }
      }
    };
    if (!sameSelection(selection, selectedLabels)) return { availability: "AVAILABLE", view };

    const destination = `taobao-${safeFileComponent(itemId)}-${this.uuid()}.png`;
    if (destination.includes("/") || destination.includes("\\") || !destination.endsWith(".png")) {
      throw new UiContractChangedError("Generated price evidence filename is invalid.");
    }
    await this.client.command("screenshot", { destination });
    if (this.workDir) view.evidencePath = join(this.workDir, destination);
    return { availability: "AVAILABLE", view };
  }

  async returnToSearch(): Promise<void> {
    await this.ensureSupported();
    if (!this.currentSearchQuery) {
      this.currentItemId = null;
      return;
    }
    const detail = await this.client.snapshot();
    assertNoStopState(detail);
    const back = findBackAction(detail);
    await this.client.command("perform", {
      nodePath: back.path,
      action: "AXPress",
      fingerprint: fingerprintFor(back)
    });
    await this.waitForStableSearchReturn(this.currentSearchQuery);
    this.currentItemId = null;
  }

  private async ensureSupported(): Promise<AxHelperDiagnosticPayload> {
    if (this.diagnostic) return this.diagnostic;
    const diagnostic = await this.client.diagnose();
    if (diagnostic.shortVersion !== SUPPORTED_VERSION || diagnostic.build !== SUPPORTED_BUILD) {
      throw new AppVersionUnsupportedError(diagnostic.shortVersion, diagnostic.build);
    }
    this.diagnostic = diagnostic;
    return diagnostic;
  }

  private async waitForSearch(query: string): Promise<AxNode> {
    const deadline = this.now() + STABILITY_TIMEOUT_MS;
    while (true) {
      const root = await this.client.snapshot();
      assertNoStopState(root);
      const field = findSearchField(root);
      if (field.value === query) {
        readSearchCards(root);
        return root;
      }
      if (this.now() >= deadline) {
        throw new UiContractChangedError("Taobao search results did not appear within 15 seconds.");
      }
      await this.sleep(POLL_INTERVAL_MS);
    }
  }

  private tryLocateVisibleCard(root: AxNode, position: DriverSearchPosition): SelectedSearchCard | null {
    const cards = readSearchCards(root);
    const sameIdentity = (card: SelectedSearchCard) => this.cardMatchesPosition(card, position);
    const candidates = cards.filter(sameIdentity);
    const priorDuplicateCount = Math.max(0, position.rank - 1);
    const sameBefore = cards.slice(0, priorDuplicateCount).filter(sameIdentity).length;
    return candidates[sameBefore] ?? candidates[0] ?? null;
  }

  private async locateCard(root: AxNode, position: DriverSearchPosition): Promise<SelectedSearchCard> {
    const visible = this.tryLocateVisibleCard(root, position);
    if (visible) return visible;
    if (!this.currentSearchQuery) {
      throw new UiContractChangedError("Taobao search result position is no longer visible.");
    }

    await this.client.command("keyPress", { keyCode: 115 });
    let current = await this.waitForSearch(this.currentSearchQuery);
    const aggregate: SelectedSearchCard[] = [];
    for (let scrollCount = 0; scrollCount <= 50; scrollCount += 1) {
      const next = readSearchCards(current);
      const overlap = overlapLength(aggregate, next);
      const viewportStart = aggregate.length - overlap;
      aggregate.push(...next.slice(overlap));
      const localIndex = position.rank - 1 - viewportStart;
      if (localIndex >= 0 && localIndex < next.length) {
        const candidate = next[localIndex];
        if (candidate && this.cardMatchesPosition(candidate, position)) return candidate;
      }
      if (hasSearchEndMarker(current)) break;
      const container = findSearchResultContainer(current);
      if (!container.actions.includes("AXScrollDown")) break;
      await this.client.command("perform", {
        nodePath: container.path,
        action: "AXScrollDown",
        fingerprint: fingerprintFor(container)
      });
      current = await this.waitForSearch(this.currentSearchQuery);
    }
    throw new UiContractChangedError("Taobao search result position is no longer visible.");
  }

  private cardMatchesPosition(card: SelectedSearchCard, position: DriverSearchPosition): boolean {
    return position.platformItemId !== null
      ? card.platformItemId === position.platformItemId
      : card.url === position.url && card.title === position.title && card.shopName === position.shopName;
  }

  private async waitForStableDetail(): Promise<AxNode> {
    const deadline = this.now() + STABILITY_TIMEOUT_MS;
    let previous = "";
    let consecutive = 0;
    while (true) {
      const root = await this.client.snapshot();
      assertNoStopState(root);
      const detail = readDetailPage(root);
      const current = JSON.stringify([detail.platformItemId, detail.url, detail.title, detail.shopName]);
      consecutive = current === previous ? consecutive + 1 : 1;
      previous = current;
      if (consecutive === STABLE_OBSERVATION_COUNT) return root;
      if (this.now() >= deadline) throw new UiContractChangedError("Taobao item detail did not stabilize within 15 seconds.");
      await this.sleep(POLL_INTERVAL_MS);
    }
  }

  private async waitForStableSku(initial: AxNode): Promise<AxNode> {
    const deadline = this.now() + STABILITY_TIMEOUT_MS;
    let root = initial;
    let previous = "";
    let consecutive = 0;
    while (true) {
      assertNoStopState(root);
      const detail = readDetailPage(root);
      const selectedLabels = readSelectedLabels(root);
      const evidence = readSelectedSkuEvidence(root);
      const current = JSON.stringify([
        selectionKey(selectedLabels),
        detail.platformItemId ?? this.currentItemId,
        evidence.activityPriceText,
        evidence.promotionTexts
      ]);
      consecutive = current === previous ? consecutive + 1 : 1;
      previous = current;
      if (consecutive === STABLE_OBSERVATION_COUNT) return root;
      if (this.now() >= deadline) throw new PriceUnstableError();
      await this.sleep(POLL_INTERVAL_MS);
      root = await this.client.snapshot();
    }
  }

  private async waitForStableSearchReturn(query: string): Promise<void> {
    const deadline = this.now() + STABILITY_TIMEOUT_MS;
    let previous = "";
    let consecutive = 0;
    while (true) {
      const root = await this.client.snapshot();
      assertNoStopState(root);
      const field = findSearchField(root);
      const cards = readSearchCards(root);
      const current = JSON.stringify([field.value, cards.map(cardKey)]);
      consecutive = field.value === query && current === previous ? consecutive + 1 : field.value === query ? 1 : 0;
      previous = current;
      if (consecutive === STABLE_OBSERVATION_COUNT) return;
      if (this.now() >= deadline) throw new UiContractChangedError("Taobao search state did not return within 15 seconds.");
      await this.sleep(POLL_INTERVAL_MS);
    }
  }
}

function safeFileComponent(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 80);
  if (!safe) throw new MissingItemIdError();
  return safe;
}
