import type { CollectorJob, CollectorReport } from "@stau-price-monitor/contracts";

import type { CollectorCheckpoint } from "./checkpoint-store.ts";

const TERMINAL_SKU_ISSUE_CODES = new Set([
  "SKU_ENUMERATION_INCOMPLETE",
  "SKU_SELECTION_MISMATCH",
  "PRICE_UNSTABLE"
]);
const PARTIAL_FAILURE_ISSUE_CODES = new Set([
  "ITEM_UNAVAILABLE",
  "SKU_ENUMERATION_INCOMPLETE",
  "SKU_SELECTION_MISMATCH",
  "PRICE_UNSTABLE",
  "UI_CONTRACT_CHANGED"
]);

function semanticValidationError(): TypeError {
  return new TypeError("Checkpoint semantic validation failed");
}

function canonicalUrl(url: string): string {
  const parsed = new URL(url);
  parsed.hash = "";
  parsed.searchParams.sort();
  return parsed.toString();
}

export function canonicalCheckpointIdentity(
  checkpoint: CollectorCheckpoint,
  identity: string
): string {
  let current = identity;
  while (checkpoint.identityAliases[current] !== undefined) {
    current = checkpoint.identityAliases[current]!;
  }
  return current;
}

export function canonicalCheckpointSkuKey(
  checkpoint: CollectorCheckpoint,
  identity: string,
  skuId: string
): string {
  return JSON.stringify([canonicalCheckpointIdentity(checkpoint, identity), skuId]);
}

function hasTerminalItemState(report: CollectorReport, identity: string): boolean {
  const item = [...report.ownItems, ...report.competitorItems]
    .find((candidate) => candidate.platformItemId === identity);
  if (item?.skus.length) return true;
  return report.issues.some((entry) => entry.platformItemId === identity
    && (entry.code === "ITEM_UNAVAILABLE" || entry.code === "SKU_ENUMERATION_INCOMPLETE"));
}

export function assertCheckpointSemanticCoherence(
  checkpoint: CollectorCheckpoint,
  job: CollectorJob
): void {
  const { report } = checkpoint;
  if (checkpoint.runId !== job.runId
    || report.runId !== job.runId
    || report.collectorId !== job.collectorId
    || report.searchLimit !== job.searchLimit) {
    throw semanticValidationError();
  }

  const hasLoginIssue = report.issues.some((entry) => entry.code === "LOGIN_REQUIRED");
  const hasChallengeIssue = report.issues.some((entry) => entry.code === "PLATFORM_CHALLENGE");
  if ((report.status === "PAUSED_LOGIN" && (!hasLoginIssue || hasChallengeIssue))
    || (report.status === "PAUSED_CHALLENGE" && (!hasChallengeIssue || hasLoginIssue))
    || (report.status !== "PAUSED_LOGIN" && report.status !== "PAUSED_CHALLENGE"
      && (hasLoginIssue || hasChallengeIssue))) {
    throw semanticValidationError();
  }

  const ownListingsById = new Map<string, CollectorJob["ownListings"]>();
  for (const listing of job.ownListings) {
    const matching = ownListingsById.get(listing.id) ?? [];
    matching.push(listing);
    ownListingsById.set(listing.id, matching);
  }
  for (const item of report.ownItems) {
    const matchingListings = ownListingsById.get(item.ownListingId) ?? [];
    if (item.shopName !== job.ownShopName || !matchingListings.some((listing) =>
      canonicalUrl(listing.url) === canonicalUrl(item.url))) {
      throw semanticValidationError();
    }
  }

  const positionIds = new Set(report.positions.map((position) => position.platformItemId));
  const itemIds = new Set([...report.ownItems, ...report.competitorItems]
    .map((item) => item.platformItemId));
  for (const alias of Object.keys(checkpoint.identityAliases)) {
    const resolved = canonicalCheckpointIdentity(checkpoint, alias);
    const matchingPositions = report.positions.filter((position) => canonicalUrl(position.url) === alias);
    if (matchingPositions.length === 0
      || matchingPositions.some((position) => position.platformItemId !== resolved)
      || !positionIds.has(resolved)
      || positionIds.has(alias)
      || itemIds.has(alias)) {
      throw semanticValidationError();
    }
  }
  for (const identity of [...positionIds, ...itemIds]) {
    if (canonicalCheckpointIdentity(checkpoint, identity) !== identity) throw semanticValidationError();
  }
  for (const item of report.competitorItems) {
    if (!positionIds.has(item.platformItemId) || item.searchRanks.length === 0) {
      throw semanticValidationError();
    }
  }

  const completedOwnListingIds = new Set(checkpoint.completedOwnListingIds);
  const jobOwnListingIds = new Set(job.ownListings.map((listing) => listing.id));
  const completedPlatformIds = new Set<string>();
  for (const identity of checkpoint.completedPlatformItemIds) {
    if (canonicalCheckpointIdentity(checkpoint, identity) !== identity) throw semanticValidationError();
    completedPlatformIds.add(identity);
  }
  const ownItemPlatformIds = new Set(report.ownItems.map((item) => item.platformItemId));

  for (const ownListingId of completedOwnListingIds) {
    const item = report.ownItems.find((candidate) => candidate.ownListingId === ownListingId);
    if (!jobOwnListingIds.has(ownListingId)
      || !item
      || !completedPlatformIds.has(item.platformItemId)
      || !hasTerminalItemState(report, item.platformItemId)) {
      throw semanticValidationError();
    }
  }
  for (const identity of completedPlatformIds) {
    if (!hasTerminalItemState(report, identity)) throw semanticValidationError();
  }

  const completedSkuKeys = new Set<string>();
  for (const serialized of checkpoint.completedSkuKeys) {
    const [identity, skuId] = JSON.parse(serialized) as [string, string];
    const resolvedIdentity = canonicalCheckpointIdentity(checkpoint, identity);
    const key = canonicalCheckpointSkuKey(checkpoint, identity, skuId);
    if (serialized !== key) throw semanticValidationError();
    if (completedSkuKeys.has(key)) throw semanticValidationError();
    completedSkuKeys.add(key);

    const observed = [...report.ownItems, ...report.competitorItems].some((item) =>
      item.platformItemId === resolvedIdentity && item.skus.some((sku) => sku.skuId === skuId));
    const terminalIssue = report.issues.some((entry) => entry.platformItemId === resolvedIdentity
      && entry.skuId === skuId && TERMINAL_SKU_ISSUE_CODES.has(entry.code));
    if (!observed && !terminalIssue) throw semanticValidationError();
  }
  for (const item of [...report.ownItems, ...report.competitorItems]) {
    for (const sku of item.skus) {
      if (!completedSkuKeys.has(canonicalCheckpointSkuKey(checkpoint, item.platformItemId, sku.skuId))) {
        throw semanticValidationError();
      }
    }
  }
  for (const entry of report.issues) {
    if (entry.platformItemId && entry.skuId && TERMINAL_SKU_ISSUE_CODES.has(entry.code)
      && !completedSkuKeys.has(canonicalCheckpointSkuKey(checkpoint, entry.platformItemId, entry.skuId))) {
      throw semanticValidationError();
    }
  }

  const usedEvidenceKeys = new Set<string>();
  for (const item of [...report.ownItems, ...report.competitorItems]) {
    for (const sku of item.skus) {
      if (sku.evidenceKey !== null) usedEvidenceKeys.add(sku.evidenceKey);
    }
  }
  for (const entry of report.issues) {
    if (entry.evidenceKey) usedEvidenceKeys.add(entry.evidenceKey);
  }
  if ([...usedEvidenceKeys].some((key) => checkpoint.evidenceManifest[key] === undefined)
    || Object.keys(checkpoint.evidenceManifest).some((key) => !usedEvidenceKeys.has(key))) {
    throw semanticValidationError();
  }

  const allOwnListingsCompleted = [...jobOwnListingIds]
    .every((listingId) => completedOwnListingIds.has(listingId));
  const completedSkuIdentities = new Set([...completedSkuKeys]
    .map((key) => (JSON.parse(key) as [string, string])[0]));
  if (checkpoint.phase === "OWN_LISTINGS") {
    if (report.positions.length > 0
      || report.competitorItems.length > 0
      || Object.keys(checkpoint.identityAliases).length > 0
      || [...completedPlatformIds].some((identity) => !ownItemPlatformIds.has(identity))
      || [...completedSkuIdentities].some((identity) => !ownItemPlatformIds.has(identity))) {
      throw semanticValidationError();
    }
  } else {
    if (!allOwnListingsCompleted) throw semanticValidationError();
    if (checkpoint.phase === "SEARCH" && (report.competitorItems.length > 0
      || [...completedPlatformIds].some((identity) => !ownItemPlatformIds.has(identity))
      || [...completedSkuIdentities].some((identity) => !ownItemPlatformIds.has(identity)))) {
      throw semanticValidationError();
    }
  }

  if (checkpoint.phase === "COMPLETE") {
    const expectedStatus = report.issues.some((entry) => PARTIAL_FAILURE_ISSUE_CODES.has(entry.code))
      ? "PARTIAL_FAILED"
      : "SUCCEEDED";
    if (report.status !== expectedStatus) {
      throw semanticValidationError();
    }
    if (report.positions.some((position) => !completedPlatformIds.has(position.platformItemId))
      || report.competitorItems.some((item) => !completedPlatformIds.has(item.platformItemId))) {
      throw semanticValidationError();
    }
  } else if (report.status === "SUCCEEDED") {
    throw semanticValidationError();
  }
}
