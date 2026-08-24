import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { moneyFromYuan } from "@stau-price-monitor/config/money";
import { calculatePublicPrice } from "@stau-price-monitor/config/public-price";
import {
  collectorJobSchema,
  collectorReportSchema,
  type CollectedItem,
  type CollectedSku,
  type CollectorIssue,
  type CollectorJob,
  type CollectorReport
} from "@stau-price-monitor/contracts";

import { AtomicCheckpointStore, type CollectorCheckpoint } from "./checkpoint-store.ts";
import {
  LoginRequiredError,
  PlatformChallengeError,
  UiContractChangedError,
  type DriverItemPage,
  type DriverSearchPosition,
  type DriverSkuView,
  type SkuSelection,
  type TaobaoDesktopDriver
} from "./desktop-driver.ts";
import { enumerateSkuSelections } from "./sku-enumerator.ts";

const PAUSE_INCOMPLETE_MESSAGE = "Collection paused before SKU enumeration completed";

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalValue(entry)]));
  }
  return value;
}

export function hashCollectorJob(job: CollectorJob): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonicalValue(job))).digest("hex")}`;
}

function canonicalUrl(url: string): string {
  const parsed = new URL(url);
  parsed.hash = "";
  parsed.searchParams.sort();
  return parsed.toString();
}

function itemIdentity(platformItemId: string | null, url: string): string {
  return platformItemId ?? canonicalUrl(url);
}

function sameSelection(left: SkuSelection, right: SkuSelection): boolean {
  const leftEntries = Object.entries(left).sort(([a], [b]) => a.localeCompare(b));
  const rightEntries = Object.entries(right).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries);
}

function skuIdFor(page: DriverItemPage, selection: SkuSelection): string {
  if (page.skuDimensions.length === 0) return "default";
  return page.skuDimensions.map((dimension) => {
    const selectedLabel = selection[dimension.name];
    const option = dimension.options.find((candidate) => candidate.label === selectedLabel);
    if (!option) throw new TypeError(`Selection has no option ID for ${dimension.name}`);
    return option.id;
  }).join("|");
}

function selectionLabel(page: DriverItemPage, selection: SkuSelection): string {
  if (page.skuDimensions.length === 0) return "默认规格";
  return page.skuDimensions.map((dimension) => selection[dimension.name] ?? "").join(" / ");
}

function requiredMoney(text: string | null, label: string): number {
  if (text === null) throw new TypeError(`${label} is missing`);
  return moneyFromYuan(text);
}

function optionalMoney(text: string | null): number | undefined {
  return text === null ? undefined : moneyFromYuan(text);
}

function addUnique(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value);
}

function now(): string {
  return new Date().toISOString();
}

function issue(
  code: CollectorIssue["code"],
  message: string,
  capturedAt: string,
  platformItemId?: string,
  skuId?: string
): CollectorIssue {
  const result: CollectorIssue = { code, message, capturedAt };
  if (platformItemId !== undefined) result.platformItemId = platformItemId;
  if (skuId !== undefined) result.skuId = skuId;
  return result;
}

function findItem(report: CollectorReport, identity: string): CollectedItem | undefined {
  return [...report.ownItems, ...report.competitorItems].find((item) => item.platformItemId === identity);
}

function addIssueOnce(report: CollectorReport, nextIssue: CollectorIssue): void {
  const duplicate = report.issues.some((current) => current.code === nextIssue.code
    && current.message === nextIssue.message
    && current.platformItemId === nextIssue.platformItemId
    && current.skuId === nextIssue.skuId);
  if (!duplicate) report.issues.push(nextIssue);
}

export class CollectionRunner {
  private readonly driver: TaobaoDesktopDriver;
  private readonly checkpointStore: AtomicCheckpointStore;

  constructor(driver: TaobaoDesktopDriver, checkpointStore: AtomicCheckpointStore) {
    this.driver = driver;
    this.checkpointStore = checkpointStore;
  }

  async run(inputJob: CollectorJob, collectorId: string): Promise<CollectorReport> {
    const job = collectorJobSchema.parse(inputJob);
    if (job.collectorId !== collectorId) {
      throw new TypeError("Collector ID does not match the validated job");
    }

    const jobHash = hashCollectorJob(job);
    const existing = await this.checkpointStore.load(job.runId);
    if (existing && existing.jobHash !== jobHash) {
      throw new TypeError("Checkpoint job hash mismatch; refusing resume");
    }
    if (existing?.phase === "COMPLETE") return collectorReportSchema.parse(existing.report);

    const checkpoint = existing ?? await this.newCheckpoint(job, collectorId, jobHash);
    checkpoint.report.issues = checkpoint.report.issues.filter((entry) =>
      entry.code !== "LOGIN_REQUIRED" && entry.code !== "PLATFORM_CHALLENGE"
      && entry.message !== PAUSE_INCOMPLETE_MESSAGE);

    try {
      if (checkpoint.phase === "OWN_LISTINGS") {
        await this.collectOwnListings(job, checkpoint);
        checkpoint.phase = "SEARCH";
        await this.checkpointStore.save(job.runId, checkpoint);
      }

      if (checkpoint.phase === "SEARCH") {
        await this.collectSearch(job, checkpoint);
        checkpoint.phase = "ITEMS";
        await this.checkpointStore.save(job.runId, checkpoint);
      }

      if (checkpoint.phase === "ITEMS") {
        await this.collectSearchItems(checkpoint);
      }

      checkpoint.phase = "COMPLETE";
      checkpoint.report.status = checkpoint.report.issues.some((entry) => [
        "ITEM_UNAVAILABLE",
        "SKU_ENUMERATION_INCOMPLETE",
        "SKU_SELECTION_MISMATCH",
        "PRICE_UNSTABLE",
        "UI_CONTRACT_CHANGED"
      ].includes(entry.code)) ? "PARTIAL_FAILED" : "SUCCEEDED";
      checkpoint.report.completedAt = now();
      const finalReport = collectorReportSchema.parse(checkpoint.report);
      checkpoint.report = finalReport;
      await this.checkpointStore.save(job.runId, checkpoint);
      return finalReport;
    } catch (error) {
      if (error instanceof LoginRequiredError) {
        return this.pause(checkpoint, "PAUSED_LOGIN", "LOGIN_REQUIRED", error.message);
      }
      if (error instanceof PlatformChallengeError) {
        return this.pause(checkpoint, "PAUSED_CHALLENGE", "PLATFORM_CHALLENGE", error.message);
      }
      if (error instanceof UiContractChangedError) {
        addIssueOnce(checkpoint.report, issue("UI_CONTRACT_CHANGED", error.message, now()));
        checkpoint.report.status = checkpoint.report.positions.length === 0
          && checkpoint.report.ownItems.length === 0 ? "FAILED" : "PARTIAL_FAILED";
        checkpoint.report.completedAt = now();
        this.ensureBoundaryIssues(checkpoint.report);
        await this.checkpointStore.save(checkpoint.runId, checkpoint);
        return collectorReportSchema.parse(checkpoint.report);
      }
      throw error;
    }
  }

  private async newCheckpoint(
    job: CollectorJob,
    collectorId: string,
    jobHash: string
  ): Promise<CollectorCheckpoint> {
    const diagnostic = await this.driver.diagnose();
    const startedAt = now();
    return {
      schemaVersion: 1,
      runId: job.runId,
      jobHash,
      phase: "OWN_LISTINGS",
      completedOwnListingIds: [],
      completedPlatformItemIds: [],
      completedSkuKeys: [],
      report: {
        schemaVersion: 1,
        runId: job.runId,
        collectorId,
        appVersion: diagnostic.appVersion ?? "unknown",
        startedAt,
        completedAt: startedAt,
        status: "FAILED",
        searchLimit: job.searchLimit,
        positions: [],
        ownItems: [],
        competitorItems: [],
        issues: []
      },
      evidenceManifest: {}
    };
  }

  private async collectOwnListings(job: CollectorJob, checkpoint: CollectorCheckpoint): Promise<void> {
    for (const listing of job.ownListings) {
      if (checkpoint.completedOwnListingIds.includes(listing.id)) continue;

      const page = await this.driver.openOwnListing(listing.url);
      const identity = itemIdentity(page.platformItemId, page.url);
      let item = checkpoint.report.ownItems.find((candidate) => candidate.ownListingId === listing.id);
      if (!item) {
        item = {
          ownListingId: listing.id,
          platformItemId: identity,
          url: page.url,
          shopName: page.shopName,
          title: page.title,
          searchRanks: [],
          skus: []
        };
        checkpoint.report.ownItems.push(item);
      }

      await this.collectItemSkus(page, item, checkpoint);
      addUnique(checkpoint.completedOwnListingIds, listing.id);
      addUnique(checkpoint.completedPlatformItemIds, identity);
      await this.driver.returnToSearch();
      await this.checkpointStore.save(checkpoint.runId, checkpoint);
    }
  }

  private async collectSearch(job: CollectorJob, checkpoint: CollectorCheckpoint): Promise<void> {
    const positions = await this.driver.search(job.searchQuery, job.searchLimit);
    checkpoint.report.positions = positions.map((position) => ({
      rank: position.rank,
      platformItemId: itemIdentity(position.platformItemId, position.url),
      url: position.url,
      shopName: position.shopName,
      title: position.title,
      displayPriceMinFen: requiredMoney(position.displayPriceMinText, "Search minimum price"),
      displayPriceMaxFen: requiredMoney(position.displayPriceMaxText, "Search maximum price"),
      sponsored: position.sponsored,
      capturedAt: position.capturedAt
    }));

    const ranksByIdentity = new Map<string, number[]>();
    for (const position of checkpoint.report.positions) {
      const ranks = ranksByIdentity.get(position.platformItemId) ?? [];
      ranks.push(position.rank);
      ranksByIdentity.set(position.platformItemId, ranks);
    }
    for (const ownItem of checkpoint.report.ownItems) {
      ownItem.searchRanks = ranksByIdentity.get(ownItem.platformItemId) ?? [];
    }
  }

  private async collectSearchItems(checkpoint: CollectorCheckpoint): Promise<void> {
    const firstPositionByIdentity = new Map<string, DriverSearchPosition>();
    for (const position of checkpoint.report.positions) {
      if (!firstPositionByIdentity.has(position.platformItemId)) {
        firstPositionByIdentity.set(position.platformItemId, {
          rank: position.rank,
          platformItemId: position.platformItemId === canonicalUrl(position.url)
            ? null
            : position.platformItemId,
          url: position.url,
          shopName: position.shopName,
          title: position.title,
          displayPriceMinText: (position.displayPriceMinFen / 100).toFixed(2),
          displayPriceMaxText: (position.displayPriceMaxFen / 100).toFixed(2),
          sponsored: position.sponsored,
          capturedAt: position.capturedAt,
          rawEvidence: { source: "checkpoint:search-position", capturedAt: position.capturedAt, metadata: {} }
        });
      }
    }

    for (const [identity, position] of firstPositionByIdentity) {
      if (checkpoint.completedPlatformItemIds.includes(identity)) continue;

      const page = await this.driver.openSearchPosition(position);
      const pageIdentity = itemIdentity(page.platformItemId, page.url);
      const ranks = checkpoint.report.positions
        .filter((candidate) => candidate.platformItemId === identity)
        .map((candidate) => candidate.rank);
      let item = findItem(checkpoint.report, pageIdentity);
      if (!item) {
        item = {
          platformItemId: pageIdentity,
          url: page.url,
          shopName: page.shopName,
          title: page.title,
          searchRanks: ranks,
          skus: []
        };
        checkpoint.report.competitorItems.push(item);
      } else {
        item.searchRanks = [...new Set([...item.searchRanks, ...ranks])].sort((a, b) => a - b);
      }

      await this.collectItemSkus(page, item, checkpoint);
      addUnique(checkpoint.completedPlatformItemIds, identity);
      if (pageIdentity !== identity) addUnique(checkpoint.completedPlatformItemIds, pageIdentity);
      await this.driver.returnToSearch();
      await this.checkpointStore.save(checkpoint.runId, checkpoint);
    }
  }

  private async collectItemSkus(
    page: DriverItemPage,
    item: CollectedItem,
    checkpoint: CollectorCheckpoint
  ): Promise<void> {
    let selections: SkuSelection[];
    try {
      selections = enumerateSkuSelections(page.skuDimensions);
    } catch (error) {
      addIssueOnce(checkpoint.report, issue(
        "SKU_ENUMERATION_INCOMPLETE",
        error instanceof Error ? error.message : "SKU enumeration failed",
        page.rawEvidence.capturedAt,
        item.platformItemId
      ));
      return;
    }

    if (page.pageSkuCount !== undefined && page.pageSkuCount !== selections.length) {
      addIssueOnce(checkpoint.report, issue(
        "SKU_ENUMERATION_INCOMPLETE",
        `Expected ${page.pageSkuCount} SKUs but enumerated ${selections.length}`,
        page.rawEvidence.capturedAt,
        item.platformItemId
      ));
    }
    if (selections.length === 0) {
      addIssueOnce(checkpoint.report, issue(
        "SKU_ENUMERATION_INCOMPLETE",
        "No enabled SKU combinations were available",
        page.rawEvidence.capturedAt,
        item.platformItemId
      ));
    }

    for (const selection of selections) {
      const skuId = skuIdFor(page, selection);
      const completedSkuKey = `${item.platformItemId}:${skuId}`;
      if (checkpoint.completedSkuKeys.includes(completedSkuKey)) continue;

      const result = await this.driver.selectSku(selection);
      if (result.availability === "UNAVAILABLE") {
        addIssueOnce(checkpoint.report, issue(
          "SKU_ENUMERATION_INCOMPLETE",
          `SKU ${selectionLabel(page, selection)} unavailable: ${result.reason}`,
          now(),
          item.platformItemId,
          skuId
        ));
        await this.completeSku(checkpoint, completedSkuKey);
        continue;
      }

      if (!sameSelection(selection, result.view.selectedLabels)) {
        addIssueOnce(checkpoint.report, issue(
          "SKU_SELECTION_MISMATCH",
          `Requested ${selectionLabel(page, selection)} but the selected labels differed`,
          result.view.capturedAt,
          item.platformItemId,
          skuId
        ));
        await this.completeSku(checkpoint, completedSkuKey);
        continue;
      }

      try {
        const sku = await this.collectedSku(page, selection, skuId, result.view, checkpoint);
        if (!item.skus.some((candidate) => candidate.skuId === sku.skuId)) item.skus.push(sku);
      } catch (error) {
        addIssueOnce(checkpoint.report, issue(
          "PRICE_UNSTABLE",
          error instanceof Error ? error.message : "Selected SKU price was unstable",
          result.view.capturedAt,
          item.platformItemId,
          skuId
        ));
      }
      await this.completeSku(checkpoint, completedSkuKey);
    }

    if (item.skus.length === 0) {
      addIssueOnce(checkpoint.report, issue(
        "SKU_ENUMERATION_INCOMPLETE",
        "No SKU produced a validated selected-SKU price",
        page.rawEvidence.capturedAt,
        item.platformItemId
      ));
    }
  }

  private async collectedSku(
    page: DriverItemPage,
    selection: SkuSelection,
    skuId: string,
    view: DriverSkuView,
    checkpoint: CollectorCheckpoint
  ): Promise<CollectedSku> {
    const listPriceFen = requiredMoney(view.listPriceText, "Selected SKU list price");
    const activityPriceFen = requiredMoney(view.activityPriceText, "Selected SKU activity price");
    const mandatoryFeeFen = requiredMoney(view.mandatoryFeeText, "Selected SKU mandatory fee");
    const displayedEstimatedPayableFen = optionalMoney(view.officialEstimatedPayablePriceText);
    const price = calculatePublicPrice({
      listPriceFen,
      activityPriceFen,
      promotions: view.promotions,
      mandatoryFeeFen,
      ...(displayedEstimatedPayableFen === undefined ? {} : { displayedEstimatedPayableFen })
    });

    let evidenceKey: string | null = null;
    if (view.evidencePath !== undefined) {
      evidenceKey = `sha256:${createHash("sha256").update(await readFile(view.evidencePath)).digest("hex")}`;
      checkpoint.evidenceManifest[evidenceKey] = view.evidencePath;
    }

    return {
      skuId,
      label: selectionLabel(page, selection),
      attributes: structuredClone(selection),
      stockState: view.stockState,
      listPriceFen: price.listPriceFen,
      activityPriceFen: price.activityPriceFen,
      couponDiscountFen: price.couponDiscountFen,
      fullReductionFen: price.fullReductionFen,
      directDiscountFen: price.directDiscountFen,
      promotions: structuredClone(view.promotions),
      mandatoryFeeFen: price.mandatoryFeeFen,
      priceConfidence: price.confidence,
      payableFen: price.payableFen,
      capturedAt: view.capturedAt,
      evidenceKey
    };
  }

  private async completeSku(checkpoint: CollectorCheckpoint, completedSkuKey: string): Promise<void> {
    addUnique(checkpoint.completedSkuKeys, completedSkuKey);
    checkpoint.report.completedAt = now();
    await this.checkpointStore.save(checkpoint.runId, checkpoint);
  }

  private async pause(
    checkpoint: CollectorCheckpoint,
    status: "PAUSED_LOGIN" | "PAUSED_CHALLENGE",
    code: "LOGIN_REQUIRED" | "PLATFORM_CHALLENGE",
    message: string
  ): Promise<CollectorReport> {
    checkpoint.report.status = status;
    checkpoint.report.completedAt = now();
    addIssueOnce(checkpoint.report, issue(code, message || code, checkpoint.report.completedAt));
    this.ensureBoundaryIssues(checkpoint.report);
    const pausedReport = collectorReportSchema.parse(checkpoint.report);
    checkpoint.report = pausedReport;
    await this.checkpointStore.save(checkpoint.runId, checkpoint);
    return pausedReport;
  }

  private ensureBoundaryIssues(report: CollectorReport): void {
    for (const item of [...report.ownItems, ...report.competitorItems]) {
      if (item.skus.length === 0) {
        addIssueOnce(report, issue(
          "SKU_ENUMERATION_INCOMPLETE",
          PAUSE_INCOMPLETE_MESSAGE,
          report.completedAt,
          item.platformItemId
        ));
      }
    }
  }
}
