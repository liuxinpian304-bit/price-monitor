import { readFile } from "node:fs/promises";

import type { PromotionEvidence } from "@stau-price-monitor/contracts";

import {
  LoginRequiredError,
  PlatformChallengeError,
  type DriverDiagnostic,
  type DriverItemPage,
  type DriverSearchPosition,
  type DriverSkuSelectionResult,
  type DriverSkuView,
  type SkuDimension,
  type SkuSelection,
  type TaobaoDesktopDriver
} from "../../core/desktop-driver.ts";

interface FixtureSkuView {
  selectedLabels: SkuSelection;
  listPriceText: string | null;
  activityPriceText: string | null;
  officialEstimatedPayablePriceText: string | null;
  promotions: PromotionEvidence[];
  mandatoryFeeText: string | null;
  stockState: DriverSkuView["stockState"];
  capturedAt: string;
  evidencePath?: string;
}

type FixtureSkuResult =
  | { selection: SkuSelection; availability: "AVAILABLE"; view: FixtureSkuView }
  | { selection: SkuSelection; availability: "UNAVAILABLE"; reason: string };

interface FixtureItem {
  platformItemId: string | null;
  url: string;
  shopName: string;
  title: string;
  pageSkuCount?: number;
  skuDimensions: SkuDimension[];
  skuResults: FixtureSkuResult[];
}

interface FixturePosition {
  rank: number;
  platformItemId: string | null;
  url: string;
  shopName: string;
  title: string;
  displayPriceMinText: string | null;
  displayPriceMaxText: string | null;
  sponsored: boolean;
  capturedAt: string;
}

interface FixtureFile {
  schemaVersion: 1;
  diagnostic: { appVersion: string; capturedAt: string };
  ownListings: Array<{ url: string; item: FixtureItem }>;
  search: {
    query: string;
    positions: FixturePosition[];
    items: FixtureItem[];
  };
}

export interface FixtureDriverOptions {
  pauseAfterCompletedSkuCount?: number;
  pauseType?: "LOGIN_REQUIRED" | "PLATFORM_CHALLENGE";
}

export type FixtureDriverEvent =
  | { type: "OPEN_OWN_LISTING"; platformItemId: string | null }
  | { type: "SEARCH"; query: string; limit: number }
  | { type: "OPEN_SEARCH_POSITION"; platformItemId: string | null }
  | { type: "SELECT_SKU"; platformItemId: string | null; selection: SkuSelection; completed: boolean }
  | { type: "RETURN_TO_SEARCH" };

function rawEvidence(source: string, capturedAt: string, metadata: Record<string, string | number>) {
  return { source, capturedAt, metadata };
}

function selectionKey(selection: SkuSelection): string {
  return JSON.stringify(Object.entries(selection).sort(([left], [right]) => left.localeCompare(right)));
}

function sameSelection(left: SkuSelection, right: SkuSelection): boolean {
  return selectionKey(left) === selectionKey(right);
}

function assertFixtureFile(value: unknown): asserts value is FixtureFile {
  if (typeof value !== "object" || value === null) throw new TypeError("Fixture must be an object");
  const fixture = value as Partial<FixtureFile>;
  if (fixture.schemaVersion !== 1 || !fixture.diagnostic || !Array.isArray(fixture.ownListings)
    || !fixture.search || !Array.isArray(fixture.search.positions) || !Array.isArray(fixture.search.items)) {
    throw new TypeError("Fixture does not match schema version 1");
  }
}

export class FixtureDriver implements TaobaoDesktopDriver {
  readonly events: FixtureDriverEvent[] = [];

  private readonly fixture: FixtureFile;
  private readonly options: FixtureDriverOptions;
  private currentItem: FixtureItem | null = null;
  private completedSkuCount = 0;
  private pauseThrown = false;

  private constructor(fixture: FixtureFile, options: FixtureDriverOptions) {
    this.fixture = fixture;
    this.options = options;
  }

  static async fromFile(path: string, options: FixtureDriverOptions = {}): Promise<FixtureDriver> {
    const fixture: unknown = JSON.parse(await readFile(path, "utf8"));
    assertFixtureFile(fixture);
    return new FixtureDriver(fixture, options);
  }

  async diagnose(): Promise<DriverDiagnostic> {
    const capturedAt = this.fixture.diagnostic.capturedAt;
    return {
      accessibilityTrusted: true,
      appRunning: true,
      processId: null,
      bundleId: "fixture.taobao.desktop",
      appVersion: this.fixture.diagnostic.appVersion,
      appBuild: null,
      hasFrontWindow: true,
      loginState: "LOGGED_IN",
      rawEvidence: rawEvidence("fixture:diagnostic", capturedAt, { schemaVersion: 1 })
    };
  }

  async openOwnListing(url: string): Promise<DriverItemPage> {
    const listing = this.fixture.ownListings.find((candidate) => candidate.url === url);
    if (!listing) throw new TypeError(`Own listing is absent from fixture: ${url}`);
    this.currentItem = listing.item;
    this.events.push({ type: "OPEN_OWN_LISTING", platformItemId: listing.item.platformItemId });
    return this.itemPage(listing.item, "fixture:own-item");
  }

  async search(query: string, limit: number): Promise<DriverSearchPosition[]> {
    if (query !== this.fixture.search.query) {
      throw new TypeError(`Search query is absent from fixture: ${query}`);
    }
    this.events.push({ type: "SEARCH", query, limit });
    return this.fixture.search.positions.slice(0, limit).map((position) => ({
      ...position,
      rawEvidence: rawEvidence("fixture:search-position", position.capturedAt, { rank: position.rank })
    }));
  }

  async openSearchPosition(position: DriverSearchPosition): Promise<DriverItemPage> {
    const byStableId = position.platformItemId === null ? undefined : this.fixture.search.items.find(
      (item) => item.platformItemId === position.platformItemId
    );
    const item = byStableId ?? this.fixture.search.items.find((candidate) => candidate.url === position.url);
    if (!item) throw new TypeError(`Search item is absent from fixture: ${position.url}`);
    this.currentItem = item;
    this.events.push({ type: "OPEN_SEARCH_POSITION", platformItemId: item.platformItemId });
    return this.itemPage(item, "fixture:search-item");
  }

  async selectSku(selection: SkuSelection): Promise<DriverSkuSelectionResult> {
    if (!this.currentItem) throw new TypeError("No fixture item is open");

    const shouldPause = !this.pauseThrown
      && this.options.pauseAfterCompletedSkuCount !== undefined
      && this.completedSkuCount >= this.options.pauseAfterCompletedSkuCount;
    if (shouldPause) {
      this.pauseThrown = true;
      this.events.push({
        type: "SELECT_SKU",
        platformItemId: this.currentItem.platformItemId,
        selection: structuredClone(selection),
        completed: false
      });
      if (this.options.pauseType === "PLATFORM_CHALLENGE") {
        throw new PlatformChallengeError("Fixture platform challenge");
      }
      throw new LoginRequiredError("Fixture login required");
    }

    const result = this.currentItem.skuResults.find((candidate) => sameSelection(candidate.selection, selection));
    this.events.push({
      type: "SELECT_SKU",
      platformItemId: this.currentItem.platformItemId,
      selection: structuredClone(selection),
      completed: true
    });
    this.completedSkuCount += 1;

    if (!result) return { availability: "UNAVAILABLE", reason: "Selection is absent from fixture" };
    if (result.availability === "UNAVAILABLE") return { availability: "UNAVAILABLE", reason: result.reason };

    const view = structuredClone(result.view) as DriverSkuView;
    view.rawEvidence = rawEvidence("fixture:sku-view", view.capturedAt, {
      selection: selectionKey(selection)
    });
    return { availability: "AVAILABLE", view };
  }

  async returnToSearch(): Promise<void> {
    this.currentItem = null;
    this.events.push({ type: "RETURN_TO_SEARCH" });
  }

  private itemPage(item: FixtureItem, source: string): DriverItemPage {
    const capturedAt = item.skuResults.find((result) => result.availability === "AVAILABLE")?.view.capturedAt
      ?? this.fixture.diagnostic.capturedAt;
    const page: DriverItemPage = {
      platformItemId: item.platformItemId,
      url: item.url,
      shopName: item.shopName,
      title: item.title,
      skuDimensions: structuredClone(item.skuDimensions),
      rawEvidence: rawEvidence(source, capturedAt, { skuResultCount: item.skuResults.length })
    };
    if (item.pageSkuCount !== undefined) page.pageSkuCount = item.pageSkuCount;
    return page;
  }
}
