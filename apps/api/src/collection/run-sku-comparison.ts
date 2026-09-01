import type { SkuCombinationBuildResult } from "../pricing/sku-combination.ts";

export interface RunSkuComparisonCandidate {
  snapshotId: string;
  source: "OWN" | "COMPETITOR";
  platformItemId: string;
  skuId: string;
  shopName: string;
  searchRanks: number[];
  stockState: "IN_STOCK" | "OUT_OF_STOCK" | "UNKNOWN";
  priceConfidence: "CONFIRMED" | "ESTIMATED" | "MANUAL_REVIEW";
  payableFen: number | null;
  combination: SkuCombinationBuildResult;
}

export interface SnapshotCombinationDecision {
  snapshotId: string;
  signature: string | null;
  label: string | null;
  state: "OWN" | "MATCHED" | "MISSING_OWN" | "REVIEW" | "EXCLUDED";
  comparisonOwnSnapshotId: string | null;
  reasons: string[];
}

export interface RunSkuComparisonInput {
  candidates: RunSkuComparisonCandidate[];
  ownCatalogComplete: boolean;
}

export interface RunSkuOwnBaseline {
  signature: string;
  label: string;
  selectedSnapshotId: string;
  selectedPayableFen: number;
  alternativeSnapshotIds: string[];
}

export interface RunSkuAlertCandidate {
  snapshotId: string;
  comparisonOwnSnapshotId: string;
  signature: string;
  label: string;
  competitorPayableFen: number;
  ownPayableFen: number;
  differenceFen: number;
  searchRanks: number[];
}

export interface RunSkuMissingOwnGroup {
  combinationSignature: string;
  combinationLabel: string;
  missingReason: "OWN_COMBINATION_ABSENT" | "OWN_OUT_OF_STOCK_ONLY";
  earliestRank: number | null;
  minimumConfirmedPayableFen: number;
  shops: string[];
  offerSnapshotIds: string[];
}

export interface RunSkuComparisonResult {
  bySnapshotId: Map<string, SnapshotCombinationDecision>;
  baselinesBySignature: RunSkuOwnBaseline[];
  alertCandidates: RunSkuAlertCandidate[];
  missingOwnGroups: RunSkuMissingOwnGroup[];
  reviewCount: number;
  primaryOwnSnapshotId: string | null;
}

type SignedCandidate = RunSkuComparisonCandidate & {
  combination: Extract<SkuCombinationBuildResult, { kind: "SIGNED" }>;
};

function compareText(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function compareNumber(left: number, right: number): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function compareCandidateIdentity(
  left: RunSkuComparisonCandidate,
  right: RunSkuComparisonCandidate
): number {
  return compareText(left.platformItemId, right.platformItemId)
    || compareText(left.skuId, right.skuId)
    || compareText(left.snapshotId, right.snapshotId);
}

function hasConfirmedPayable(
  candidate: RunSkuComparisonCandidate
): candidate is RunSkuComparisonCandidate & { payableFen: number } {
  return candidate.priceConfidence === "CONFIRMED"
    && Number.isSafeInteger(candidate.payableFen)
    && candidate.payableFen !== null
    && candidate.payableFen >= 0;
}

function isEligibleOwn(
  candidate: SignedCandidate
): candidate is SignedCandidate & { payableFen: number } {
  return candidate.stockState === "IN_STOCK" && hasConfirmedPayable(candidate);
}

function compareEligibleOwn(
  left: SignedCandidate & { payableFen: number },
  right: SignedCandidate & { payableFen: number }
): number {
  return compareNumber(left.payableFen, right.payableFen) || compareCandidateIdentity(left, right);
}

function compareOwnForDisplay(left: SignedCandidate, right: SignedCandidate): number {
  const leftEligible = isEligibleOwn(left);
  const rightEligible = isEligibleOwn(right);
  if (leftEligible && rightEligible) return compareEligibleOwn(left, right);
  if (leftEligible !== rightEligible) return leftEligible ? -1 : 1;

  const leftHasPrice = hasConfirmedPayable(left);
  const rightHasPrice = hasConfirmedPayable(right);
  if (leftHasPrice && rightHasPrice) {
    return compareNumber(left.payableFen, right.payableFen) || compareCandidateIdentity(left, right);
  }
  if (leftHasPrice !== rightHasPrice) return leftHasPrice ? -1 : 1;
  return compareCandidateIdentity(left, right);
}

function isSigned(candidate: RunSkuComparisonCandidate): candidate is SignedCandidate {
  return candidate.combination.kind === "SIGNED";
}

function uniqueReasons(...groups: string[][]): string[] {
  return [...new Set(groups.flat())];
}

function decision(
  candidate: RunSkuComparisonCandidate,
  state: SnapshotCombinationDecision["state"],
  reasons: string[],
  comparisonOwnSnapshotId: string | null = null
): SnapshotCombinationDecision {
  return {
    snapshotId: candidate.snapshotId,
    signature: candidate.combination.signature,
    label: candidate.combination.label,
    state,
    comparisonOwnSnapshotId,
    reasons: [...reasons]
  };
}

function ownReviewReasons(candidate: SignedCandidate): string[] {
  const reasons: string[] = [];
  if (!hasConfirmedPayable(candidate)) reasons.push("OWN_PRICE_UNCONFIRMED");
  if (candidate.stockState === "OUT_OF_STOCK") reasons.push("OWN_OUT_OF_STOCK");
  if (candidate.stockState === "UNKNOWN") reasons.push("OWN_STOCK_UNCONFIRMED");
  return uniqueReasons(candidate.combination.reasons, reasons);
}

function competitorReviewReasons(candidate: SignedCandidate): string[] {
  const reasons: string[] = [];
  if (candidate.stockState === "OUT_OF_STOCK") reasons.push("COMPETITOR_OUT_OF_STOCK");
  if (candidate.stockState === "UNKNOWN") reasons.push("COMPETITOR_STOCK_UNKNOWN");
  if (!hasConfirmedPayable(candidate)) reasons.push("COMPETITOR_PRICE_UNCONFIRMED");
  return uniqueReasons(candidate.combination.reasons, reasons);
}

function addBySignature(
  bySignature: Map<string, SignedCandidate[]>,
  candidate: SignedCandidate
): void {
  const existing = bySignature.get(candidate.combination.signature) ?? [];
  existing.push(candidate);
  bySignature.set(candidate.combination.signature, existing);
}

function sortedCandidates(candidates: RunSkuComparisonCandidate[]): RunSkuComparisonCandidate[] {
  return [...candidates].sort((left, right) =>
    compareText(left.snapshotId, right.snapshotId)
      || compareText(left.source, right.source)
      || compareCandidateIdentity(left, right)
  );
}

function compareNullableRank(left: number | null, right: number | null): number {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return compareNumber(left, right);
}

function earliestRank(candidates: SignedCandidate[]): number | null {
  const ranks = candidates.flatMap((candidate) =>
    candidate.searchRanks.filter((rank) => Number.isSafeInteger(rank) && rank >= 0)
  );
  return ranks.length === 0 ? null : Math.min(...ranks);
}

function buildMissingGroups(
  missing: Array<{
    candidate: SignedCandidate & { payableFen: number };
    reason: RunSkuMissingOwnGroup["missingReason"];
  }>
): RunSkuMissingOwnGroup[] {
  const bySignature = new Map<string, typeof missing>();
  for (const entry of missing) {
    const signature = entry.candidate.combination.signature;
    const current = bySignature.get(signature) ?? [];
    current.push(entry);
    bySignature.set(signature, current);
  }

  return [...bySignature.entries()]
    .map(([signature, entries]): RunSkuMissingOwnGroup => {
      const candidates = entries.map((entry) => entry.candidate);
      const labels = candidates.map((candidate) => candidate.combination.label).sort(compareText);
      const minimumConfirmedPayableFen = candidates.reduce(
        (minimum, candidate) => Math.min(minimum, candidate.payableFen),
        Number.MAX_SAFE_INTEGER
      );
      return {
        combinationSignature: signature,
        combinationLabel: labels[0]!,
        missingReason: entries[0]!.reason,
        earliestRank: earliestRank(candidates),
        minimumConfirmedPayableFen,
        shops: [...new Set(candidates.map((candidate) => candidate.shopName))].sort(compareText),
        offerSnapshotIds: candidates.map((candidate) => candidate.snapshotId).sort(compareText)
      };
    })
    .sort((left, right) =>
      compareNumber(left.minimumConfirmedPayableFen, right.minimumConfirmedPayableFen)
        || compareNullableRank(left.earliestRank, right.earliestRank)
        || compareText(left.combinationSignature, right.combinationSignature)
    );
}

export function evaluateRunSkuCombinations(input: RunSkuComparisonInput): RunSkuComparisonResult {
  const candidates = sortedCandidates(input.candidates);
  const allOwnBySignature = new Map<string, SignedCandidate[]>();
  const eligibleOwnBySignature = new Map<string, Array<SignedCandidate & { payableFen: number }>>();

  for (const candidate of candidates) {
    if (candidate.source !== "OWN" || !isSigned(candidate)) continue;
    addBySignature(allOwnBySignature, candidate);
    if (!isEligibleOwn(candidate)) continue;
    const existing = eligibleOwnBySignature.get(candidate.combination.signature) ?? [];
    existing.push(candidate);
    eligibleOwnBySignature.set(candidate.combination.signature, existing);
  }

  for (const rows of allOwnBySignature.values()) rows.sort(compareOwnForDisplay);
  for (const rows of eligibleOwnBySignature.values()) rows.sort(compareEligibleOwn);

  const selectedOwnBySignature = new Map<string, SignedCandidate & { payableFen: number }>();
  const baselinesBySignature = [...eligibleOwnBySignature.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([signature, eligibleRows]): RunSkuOwnBaseline => {
      const selected = eligibleRows[0]!;
      selectedOwnBySignature.set(signature, selected);
      return {
        signature,
        label: selected.combination.label,
        selectedSnapshotId: selected.snapshotId,
        selectedPayableFen: selected.payableFen,
        alternativeSnapshotIds: (allOwnBySignature.get(signature) ?? [])
          .filter((candidate) => candidate.snapshotId !== selected.snapshotId)
          .map((candidate) => candidate.snapshotId)
      };
    });

  const selectedOwn = [...selectedOwnBySignature.values()].sort(compareEligibleOwn);
  const bySnapshotId = new Map<string, SnapshotCombinationDecision>();
  const alertEntries: Array<{ candidate: SignedCandidate; alert: RunSkuAlertCandidate }> = [];
  const missingEntries: Array<{
    candidate: SignedCandidate & { payableFen: number };
    reason: RunSkuMissingOwnGroup["missingReason"];
  }> = [];

  for (const candidate of candidates) {
    if (candidate.source === "OWN") {
      if (candidate.combination.kind === "EXCLUDED") {
        bySnapshotId.set(candidate.snapshotId, decision(candidate, "EXCLUDED", candidate.combination.reasons));
      } else if (candidate.combination.kind === "REVIEW") {
        bySnapshotId.set(candidate.snapshotId, decision(candidate, "REVIEW", candidate.combination.reasons));
      } else if (isSigned(candidate) && isEligibleOwn(candidate)) {
        bySnapshotId.set(candidate.snapshotId, decision(candidate, "OWN", candidate.combination.reasons));
      } else if (isSigned(candidate)) {
        bySnapshotId.set(candidate.snapshotId, decision(candidate, "REVIEW", ownReviewReasons(candidate)));
      }
      continue;
    }

    if (candidate.combination.kind === "EXCLUDED") {
      bySnapshotId.set(candidate.snapshotId, decision(candidate, "EXCLUDED", candidate.combination.reasons));
      continue;
    }
    if (candidate.combination.kind === "REVIEW") {
      bySnapshotId.set(candidate.snapshotId, decision(candidate, "REVIEW", candidate.combination.reasons));
      continue;
    }
    if (!isSigned(candidate)) continue;

    const competitorNeedsReview = candidate.stockState !== "IN_STOCK"
      || !hasConfirmedPayable(candidate);
    const reviewReasons = competitorReviewReasons(candidate);
    if (competitorNeedsReview) {
      bySnapshotId.set(candidate.snapshotId, decision(candidate, "REVIEW", reviewReasons));
      continue;
    }

    if (!input.ownCatalogComplete) {
      bySnapshotId.set(candidate.snapshotId, decision(
        candidate,
        "REVIEW",
        uniqueReasons(candidate.combination.reasons, ["OWN_CATALOG_INCOMPLETE"])
      ));
      continue;
    }

    const signature = candidate.combination.signature;
    const selectedBaseline = selectedOwnBySignature.get(signature);
    if (selectedBaseline) {
      bySnapshotId.set(candidate.snapshotId, decision(
        candidate,
        "MATCHED",
        uniqueReasons(candidate.combination.reasons, ["EXACT_SIGNATURE"]),
        selectedBaseline.snapshotId
      ));
      if (candidate.payableFen < selectedBaseline.payableFen) {
        alertEntries.push({
          candidate,
          alert: {
            snapshotId: candidate.snapshotId,
            comparisonOwnSnapshotId: selectedBaseline.snapshotId,
            signature,
            label: candidate.combination.label,
            competitorPayableFen: candidate.payableFen,
            ownPayableFen: selectedBaseline.payableFen,
            differenceFen: selectedBaseline.payableFen - candidate.payableFen,
            searchRanks: [...candidate.searchRanks]
          }
        });
      }
      continue;
    }

    const sameSignatureOwn = allOwnBySignature.get(signature) ?? [];
    if (sameSignatureOwn.some((ownCandidate) => !hasConfirmedPayable(ownCandidate))) {
      bySnapshotId.set(candidate.snapshotId, decision(
        candidate,
        "REVIEW",
        uniqueReasons(candidate.combination.reasons, ["OWN_PRICE_UNCONFIRMED"])
      ));
      continue;
    }
    if (sameSignatureOwn.length > 0
      && sameSignatureOwn.every((ownCandidate) => ownCandidate.stockState === "OUT_OF_STOCK")) {
      bySnapshotId.set(candidate.snapshotId, decision(
        candidate,
        "MISSING_OWN",
        uniqueReasons(candidate.combination.reasons, ["OWN_OUT_OF_STOCK_ONLY"])
      ));
      missingEntries.push({ candidate, reason: "OWN_OUT_OF_STOCK_ONLY" });
      continue;
    }
    if (sameSignatureOwn.length > 0) {
      bySnapshotId.set(candidate.snapshotId, decision(
        candidate,
        "REVIEW",
        uniqueReasons(candidate.combination.reasons, ["OWN_STOCK_UNCONFIRMED"])
      ));
      continue;
    }
    bySnapshotId.set(candidate.snapshotId, decision(
      candidate,
      "MISSING_OWN",
      uniqueReasons(candidate.combination.reasons, ["OWN_COMBINATION_ABSENT"])
    ));
    missingEntries.push({ candidate, reason: "OWN_COMBINATION_ABSENT" });
  }

  const alertCandidates = alertEntries
    .sort((left, right) => compareCandidateIdentity(left.candidate, right.candidate))
    .map((entry) => entry.alert);
  const missingOwnGroups = buildMissingGroups(missingEntries);
  const reviewCount = [...bySnapshotId.values()].filter((item) => item.state === "REVIEW").length;

  return {
    bySnapshotId,
    baselinesBySignature,
    alertCandidates,
    missingOwnGroups,
    reviewCount,
    primaryOwnSnapshotId: selectedOwn[0]?.snapshotId ?? null
  };
}
