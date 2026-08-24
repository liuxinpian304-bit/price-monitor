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
  assertCheckpointSemanticCoherence,
  canonicalCheckpointIdentity,
  canonicalCheckpointSkuKey,
  isUnresolvedSearchIdentity,
  unresolvedSearchIdentity
} from "./checkpoint-semantics.ts";
import {
  DriverIssueError,
  DriverSkuIssueError,
  LoginRequiredError,
  PlatformChallengeError,
  UiContractChangedError,
  type DriverItemPage,
  type DriverSearchPosition,
  type DriverSkuSelectionResult,
  type DriverSkuView,
  type SkuSelection,
  type TaobaoDesktopDriver
} from "./desktop-driver.ts";
import { enumerateSkuSelections } from "./sku-enumerator.ts";

const PAUSE_INCOMPLETE_MESSAGE = "Collection paused before SKU enumeration completed";
const SEARCH_ID_CONFLICT_MESSAGE = "Search results exposed conflicting stable item IDs for one canonical URL";
const DETAIL_ID_MISMATCH_MESSAGE = "Search item identity changed during detail traversal";

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
  const tuple = page.skuDimensions.map((dimension) => {
    const selectedLabel = selection[dimension.name];
    const option = dimension.options.find((candidate) => candidate.label === selectedLabel);
    if (!option) throw new TypeError(`Selection has no option ID for ${dimension.name}`);
    return {
      dimension: dimension.name,
      optionId: option.id,
      optionLabel: option.label
    };
  });
  return `sku_${createHash("sha256").update(JSON.stringify(tuple)).digest("hex")}`;
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

function persistIdentityAlias(
  checkpoint: CollectorCheckpoint,
  fallbackIdentity: string,
  stableIdentity: string
): void {
  const resolvedStable = canonicalCheckpointIdentity(checkpoint, stableIdentity);
  const existing = checkpoint.identityAliases[fallbackIdentity];
  if (existing !== undefined
    && canonicalCheckpointIdentity(checkpoint, existing) !== resolvedStable) {
    throw new UiContractChangedError(SEARCH_ID_CONFLICT_MESSAGE);
  }
  if (fallbackIdentity !== resolvedStable) checkpoint.identityAliases[fallbackIdentity] = resolvedStable;
}

function completeIdentity(checkpoint: CollectorCheckpoint, identity: string): void {
  addUnique(checkpoint.completedPlatformItemIds, canonicalCheckpointIdentity(checkpoint, identity));
}

function resetSearchProgress(checkpoint: CollectorCheckpoint): void {
  const ownItemIds = new Set(checkpoint.report.ownItems.map((item) => item.platformItemId));
  checkpoint.completedPlatformItemIds = checkpoint.completedPlatformItemIds.filter((identity) =>
    ownItemIds.has(canonicalCheckpointIdentity(checkpoint, identity)));
  checkpoint.completedSkuKeys = checkpoint.completedSkuKeys.filter((serialized) => {
    const [identity] = JSON.parse(serialized) as [string, string];
    return ownItemIds.has(canonicalCheckpointIdentity(checkpoint, identity));
  });
  checkpoint.report.issues = checkpoint.report.issues.filter((entry) =>
    entry.platformItemId == null || ownItemIds.has(entry.platformItemId));
  checkpoint.report.positions = [];
  checkpoint.report.competitorItems = [];
  checkpoint.identityAliases = {};

  const retainedEvidenceKeys = new Set<string>();
  for (const item of checkpoint.report.ownItems) {
    for (const sku of item.skus) {
      if (sku.evidenceKey) retainedEvidenceKeys.add(sku.evidenceKey);
    }
  }
  for (const entry of checkpoint.report.issues) {
    if (entry.evidenceKey) retainedEvidenceKeys.add(entry.evidenceKey);
  }
  checkpoint.evidenceManifest = Object.fromEntries(Object.entries(checkpoint.evidenceManifest)
    .filter(([key]) => retainedEvidenceKeys.has(key)));
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
    if (existing) assertCheckpointSemanticCoherence(existing, job);
    if (existing?.phase === "COMPLETE") return collectorReportSchema.parse(existing.report);

    const checkpoint = existing ?? this.newCheckpoint(job, collectorId, jobHash);
    checkpoint.report.issues = checkpoint.report.issues.filter((entry) =>
      entry.code !== "LOGIN_REQUIRED" && entry.code !== "PLATFORM_CHALLENGE"
      && entry.code !== "MISSING_ITEM_ID"
      && entry.message !== PAUSE_INCOMPLETE_MESSAGE);

    try {
      if (!existing) {
        const diagnostic = await this.driver.diagnose();
        checkpoint.report.appVersion = diagnostic.appVersion ?? "unknown";
      }

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
      if (error instanceof DriverIssueError) {
        const capturedAt = now();
        if (error.code === "MISSING_ITEM_ID") {
          resetSearchProgress(checkpoint);
          if (checkpoint.phase === "ITEMS") checkpoint.phase = "SEARCH";
        }
        addIssueOnce(checkpoint.report, issue(error.code, error.message, capturedAt));
        checkpoint.report.status = checkpoint.report.positions.length === 0
          && checkpoint.report.ownItems.length === 0 ? "FAILED" : "PARTIAL_FAILED";
        checkpoint.report.completedAt = capturedAt;
        this.ensureBoundaryIssues(checkpoint.report);
        const report = collectorReportSchema.parse(checkpoint.report);
        if (error.code !== "APP_VERSION_UNSUPPORTED") {
          checkpoint.report = report;
          await this.checkpointStore.save(checkpoint.runId, checkpoint);
        }
        return report;
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

  private newCheckpoint(
    job: CollectorJob,
    collectorId: string,
    jobHash: string
  ): CollectorCheckpoint {
    const startedAt = now();
    return {
      schemaVersion: 1,
      checkpointFormatVersion: 2,
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
        appVersion: "unknown",
        startedAt,
        completedAt: startedAt,
        status: "FAILED",
        searchLimit: job.searchLimit,
        positions: [],
        ownItems: [],
        competitorItems: [],
        issues: []
      },
      evidenceManifest: {},
      identityAliases: {}
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
      platformItemId: position.platformItemId ?? unresolvedSearchIdentity(position.rank, position.url),
      url: position.url,
      shopName: position.shopName,
      title: position.title,
      displayPriceMinFen: requiredMoney(position.displayPriceMinText, "Search minimum price"),
      displayPriceMaxFen: requiredMoney(position.displayPriceMaxText, "Search maximum price"),
      sponsored: position.sponsored,
      capturedAt: position.capturedAt
    }));

    const stableIdsByCanonicalUrl = new Map<string, Set<string>>();
    for (const position of positions) {
      const url = canonicalUrl(position.url);
      const stableIds = stableIdsByCanonicalUrl.get(url) ?? new Set<string>();
      if (position.platformItemId !== null) stableIds.add(position.platformItemId);
      stableIdsByCanonicalUrl.set(url, stableIds);
    }
    for (const stableIds of stableIdsByCanonicalUrl.values()) {
      if (stableIds.size > 1) throw new UiContractChangedError(SEARCH_ID_CONFLICT_MESSAGE);
    }

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
        const normalizedIdentity = canonicalCheckpointIdentity(checkpoint, position.platformItemId);
        const unresolved = isUnresolvedSearchIdentity(position.platformItemId);
        firstPositionByIdentity.set(position.platformItemId, {
          rank: position.rank,
          platformItemId: unresolved
              && checkpoint.identityAliases[position.platformItemId] === undefined
            ? null
            : normalizedIdentity,
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
      const resolvedIdentity = canonicalCheckpointIdentity(checkpoint, identity);
      if (checkpoint.completedPlatformItemIds.includes(resolvedIdentity)) continue;

      const page = await this.driver.openSearchPosition(position);
      const pageIdentity = itemIdentity(page.platformItemId, page.url);
      const openedFromFallback = isUnresolvedSearchIdentity(identity);
      if (!openedFromFallback && page.platformItemId !== position.platformItemId) {
        throw new UiContractChangedError(DETAIL_ID_MISMATCH_MESSAGE);
      }
      if (openedFromFallback && page.platformItemId === null) {
        throw new DriverIssueError("MISSING_ITEM_ID", "A stable Taobao item ID was not available.");
      }
      if (openedFromFallback && page.platformItemId !== null && pageIdentity !== identity) {
        persistIdentityAlias(checkpoint, identity, pageIdentity);
        for (const reportPosition of checkpoint.report.positions) {
          if (reportPosition.platformItemId === identity) {
            reportPosition.platformItemId = pageIdentity;
          }
        }
      }
      const ranks = checkpoint.report.positions
        .filter((candidate) => candidate.platformItemId === pageIdentity)
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
      completeIdentity(checkpoint, pageIdentity);
      completeIdentity(checkpoint, identity);
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
      const completedSkuKey = canonicalCheckpointSkuKey(checkpoint, item.platformItemId, skuId);
      if (checkpoint.completedSkuKeys.includes(completedSkuKey)) continue;

      let result: DriverSkuSelectionResult;
      try {
        result = await this.driver.selectSku(selection);
      } catch (error) {
        if (!(error instanceof DriverSkuIssueError)) throw error;
        addIssueOnce(checkpoint.report, issue(
          error.code,
          error.message,
          now(),
          item.platformItemId,
          skuId
        ));
        if (item.skus.length === 0) {
          addIssueOnce(checkpoint.report, issue(
            "SKU_ENUMERATION_INCOMPLETE",
            "No SKU has produced a validated selected-SKU price yet",
            now(),
            item.platformItemId
          ));
        }
        await this.completeSku(checkpoint, completedSkuKey);
        continue;
      }
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
        if (item.skus.length === 0) {
          addIssueOnce(checkpoint.report, issue(
            "SKU_ENUMERATION_INCOMPLETE",
            "No SKU has produced a validated selected-SKU price yet",
            result.view.capturedAt,
            item.platformItemId
          ));
        }
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
        if (item.skus.length === 0) {
          addIssueOnce(checkpoint.report, issue(
            "SKU_ENUMERATION_INCOMPLETE",
            "No SKU has produced a validated selected-SKU price yet",
            result.view.capturedAt,
            item.platformItemId
          ));
        }
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
      let evidence: Buffer;
      try {
        evidence = await readFile(view.evidencePath);
      } catch {
        throw new Error("Selected SKU evidence could not be read");
      }
      evidenceKey = `sha256:${createHash("sha256").update(evidence).digest("hex")}`;
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
