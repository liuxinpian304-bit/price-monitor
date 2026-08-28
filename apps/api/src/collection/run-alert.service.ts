import { AlertService, type AlertOffer, type AlertRepository } from "../alerts/alert.service.ts";
import { MatcherService } from "../matching/matcher.service.ts";
import type { MatchDecision, MonitoredProductRule } from "../matching/matcher.types.ts";
import { buildSkuCombination } from "../pricing/sku-combination.ts";
import { evaluateRunSkuCombinations } from "./run-sku-comparison.ts";
import type { RawOffer } from "./providers/commerce-provider.ts";

export type PersistedMatchDecision = "BARE" | "BUNDLE" | "REJECTED" | "MANUAL";
export type BaselineIssueCode = "OWN_BASELINE_MISSING" | "OWN_BASELINE_AMBIGUOUS";

export interface RunAlertBundleItem {
  accessoryType: string;
  brand: string | null;
  modelOrName: string;
  quantity: number;
  core: boolean;
}

export interface RunAlertBundleComponent {
  role: "CORE" | "PAID_ACCESSORY" | "GIFT_OR_SERVICE" | "UNKNOWN";
  accessoryType: string;
  brand: string | null;
  modelOrName: string;
  quantity: number;
}

export interface RunAlertSnapshot {
  id: string;
  ownListingId: string | null;
  ownListingSkuText: string | null;
  searchCandidateId: string | null;
  platformItemId: string;
  skuId: string;
  shopName: string;
  title: string;
  skuText: string;
  attributes: Record<string, string>;
  components: RunAlertBundleComponent[] | null;
  listPriceFen: number;
  activityPriceFen: number;
  publicDiscountFen: number;
  payableFen: number | null;
  priceConfidence: "CONFIRMED" | "ESTIMATED" | "MANUAL_REVIEW";
  stockState: "IN_STOCK" | "OUT_OF_STOCK" | "UNKNOWN";
  capturedAt: Date;
  url: string;
  searchRanks: number[];
}

export interface RunAlertData {
  runId: string;
  status: "SUCCEEDED" | "PARTIAL_FAILED" | "FAILED";
  searchLimit: number;
  positionCount: number;
  skuCount: number;
  issueCount: number;
  completedAt: Date;
  claimedOwnListingIds: string[];
  ownCatalogComplete: boolean;
  model: {
    id: string;
    brand: string;
    standardModel: string;
    version: string | null;
    comparisonType: "BARE" | "BUNDLE";
    colorComparable: boolean;
    owner: string;
    effectiveAliases: string[];
    excludedAliases: string[];
    mustIncludeTerms: string[];
    excludedTerms: string[];
    bundleItems: RunAlertBundleItem[];
  };
  snapshots: RunAlertSnapshot[];
}

export interface SnapshotMatchPersistence {
  snapshotId: string;
  decision: PersistedMatchDecision;
  comparable: boolean;
  confidenceBps: number;
  normalizedModel: string | null;
  reasons: string[];
}

export interface CandidateMatchPersistence {
  candidateId: string;
  decision: PersistedMatchDecision;
  comparable: boolean;
  confidenceBps: number;
  normalizedModel: string | null;
  reasons: string[];
}

export interface SnapshotCombinationPersistence {
  snapshotId: string;
  signature: string | null;
  label: string | null;
  state: "OWN" | "MATCHED" | "MISSING_OWN" | "REVIEW" | "EXCLUDED";
  comparisonOwnSnapshotId: string | null;
  reasons: {
    ruleVersion: "sku-combination-v1";
    codes: string[];
  };
}

export interface RunAlertUnitOfWork {
  data: RunAlertData;
  alerts: AlertRepository;
  saveSnapshotDecisions(decisions: SnapshotMatchPersistence[]): Promise<void>;
  saveCandidateDecisions(decisions: CandidateMatchPersistence[]): Promise<void>;
  saveCombinationDecisions(decisions: SnapshotCombinationPersistence[]): Promise<void>;
  saveOwnBaselineSnapshot(snapshotId: string | null): Promise<void>;
  ensureBaselineIssue(code: BaselineIssueCode): Promise<boolean>;
  ensureNotificationBatch(summary: RunAlertSummary): Promise<void>;
}

export interface RunAlertRepository {
  withEvaluation<T>(
    runId: string,
    operation: (unit: RunAlertUnitOfWork) => Promise<T>
  ): Promise<T>;
}

export interface RunAlertBaseline {
  snapshotId: string;
  skuId: string;
  skuText: string;
  activityPriceFen: number;
  publicDiscountFen: number;
  payableFen: number;
}

export interface RunAlertEntry {
  alertId: string;
  severity: "CONFIRMED_LOW" | "MANUAL_REVIEW";
  snapshotId: string;
  ownSnapshotId: string;
  ownSkuText: string;
  ownPayableFen: number;
  combinationSignature: string;
  combinationLabel: string;
  rank: number | null;
  shopName: string;
  title: string;
  skuText: string;
  activityPriceFen: number;
  publicDiscountFen: number;
  payableFen: number;
  differenceFen: number;
  url: string;
  reasons: string[];
}

export interface RunAlertMissingOwnGroup {
  combinationSignature: string;
  combinationLabel: string;
  missingReason: "OWN_COMBINATION_ABSENT" | "OWN_OUT_OF_STOCK_ONLY";
  earliestRank: number | null;
  minimumConfirmedPayableFen: number;
  shopCount: number;
  representativeUrl: string;
}

export interface RunAlertSummary {
  runId: string;
  monitoredModelId: string;
  brand: string;
  standardModel: string;
  comparisonType: "BARE" | "BUNDLE";
  owner: string;
  completedAt: Date;
  checkedItemCount: number;
  positionCount: number;
  shopCount: number;
  searchLimit: number;
  skuCount: number;
  issueCount: number;
  reviewCount: number;
  reportUrl: string;
  baseline: RunAlertBaseline | null;
  systemIssue: BaselineIssueCode | null;
  alerts: RunAlertEntry[];
  missingOwnGroups: RunAlertMissingOwnGroup[];
}

interface EvaluatedSnapshot {
  snapshot: RunAlertSnapshot;
  persistence: SnapshotMatchPersistence;
}

function ruleFrom(data: RunAlertData): MonitoredProductRule {
  return {
    brand: data.model.brand,
    standardModel: data.model.standardModel,
    version: data.model.version,
    comparisonType: data.model.comparisonType,
    effectiveAliases: data.model.effectiveAliases,
    excludedAliases: data.model.excludedAliases,
    mustIncludeTerms: data.model.mustIncludeTerms,
    excludedTerms: data.model.excludedTerms
  };
}

function rawOffer(snapshot: RunAlertSnapshot): RawOffer {
  const payableFen = snapshot.payableFen ?? 0;
  return {
    platformItemId: snapshot.platformItemId,
    url: snapshot.url,
    shopName: snapshot.shopName,
    title: snapshot.title,
    selectedSkuId: snapshot.skuId,
    skuOptions: [{
      skuId: snapshot.skuId,
      label: snapshot.skuText,
      attributes: snapshot.attributes,
      listPriceFen: snapshot.listPriceFen,
      publicDiscountFen: snapshot.publicDiscountFen,
      payableFen,
      stockState: snapshot.stockState
    }],
    listPriceFen: snapshot.listPriceFen,
    publicDiscountFen: snapshot.publicDiscountFen,
    payableFen,
    promotions: [],
    gifts: [],
    stockState: snapshot.stockState,
    capturedAt: snapshot.capturedAt,
    evidenceUrl: null,
    rawEvidence: { attributes: snapshot.attributes }
  };
}

function persistenceDecision(snapshot: RunAlertSnapshot, rawDecision: MatchDecision): EvaluatedSnapshot {
  const decision: PersistedMatchDecision = rawDecision.category === "REJECTED"
    ? "REJECTED"
    : rawDecision.comparable
      && (rawDecision.category === "BARE" || rawDecision.category === "BUNDLE")
      ? rawDecision.category
      : "MANUAL";
  return {
    snapshot,
    persistence: {
      snapshotId: snapshot.id,
      decision,
      comparable: rawDecision.comparable,
      confidenceBps: Math.round(rawDecision.confidence * 10_000),
      normalizedModel: rawDecision.normalizedModel,
      reasons: [...rawDecision.reasons]
    }
  };
}

function candidateDecisions(evaluated: EvaluatedSnapshot[]): CandidateMatchPersistence[] {
  const byCandidate = new Map<string, EvaluatedSnapshot[]>();
  for (const entry of evaluated) {
    if (!entry.snapshot.searchCandidateId) continue;
    const current = byCandidate.get(entry.snapshot.searchCandidateId) ?? [];
    current.push(entry);
    byCandidate.set(entry.snapshot.searchCandidateId, current);
  }
  return [...byCandidate.entries()].map(([candidateId, entries]) => {
    const sorted = [...entries].sort((left, right) => {
      const priority = (decision: PersistedMatchDecision) =>
        decision === "BARE" || decision === "BUNDLE" ? 2 : decision === "MANUAL" ? 1 : 0;
      return priority(right.persistence.decision) - priority(left.persistence.decision)
        || right.persistence.confidenceBps - left.persistence.confidenceBps
        || left.snapshot.id.localeCompare(right.snapshot.id);
    });
    const selected = sorted[0]!;
    return {
      candidateId,
      decision: selected.persistence.decision,
      comparable: selected.persistence.comparable,
      confidenceBps: selected.persistence.confidenceBps,
      normalizedModel: selected.persistence.normalizedModel,
      reasons: [...selected.persistence.reasons]
    };
  });
}

function baselineSummary(snapshot: RunAlertSnapshot): RunAlertBaseline {
  return {
    snapshotId: snapshot.id,
    skuId: snapshot.skuId,
    skuText: snapshot.skuText,
    activityPriceFen: snapshot.activityPriceFen,
    publicDiscountFen: snapshot.publicDiscountFen,
    payableFen: snapshot.payableFen!
  };
}

function earliestRank(snapshot: RunAlertSnapshot): number | null {
  return snapshot.searchRanks.length === 0 ? null : Math.min(...snapshot.searchRanks);
}

function compareText(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function compareRepresentative(left: RunAlertSnapshot, right: RunAlertSnapshot): number {
  const leftRank = earliestRank(left);
  const rightRank = earliestRank(right);
  if (leftRank !== rightRank) {
    if (leftRank === null) return 1;
    if (rightRank === null) return -1;
    return leftRank - rightRank;
  }
  return compareText(left.platformItemId, right.platformItemId)
    || compareText(left.skuId, right.skuId)
    || compareText(left.id, right.id);
}

function alertOffer(
  data: RunAlertData,
  snapshot: RunAlertSnapshot,
  combinationSignature: string
): AlertOffer {
  return {
    monitoredModelId: data.model.id,
    snapshotId: snapshot.id,
    combinationSignature,
    platformItemId: snapshot.platformItemId,
    skuId: snapshot.skuId,
    brand: data.model.brand,
    standardModel: data.model.standardModel,
    comparisonType: data.model.comparisonType,
    shopName: snapshot.shopName,
    skuText: snapshot.skuText,
    payableFen: snapshot.payableFen,
    priceConfidence: snapshot.priceConfidence,
    stockState: snapshot.stockState,
    url: snapshot.url,
    capturedAt: snapshot.capturedAt,
    owner: data.model.owner
  };
}

export class RunAlertService {
  private readonly repository: RunAlertRepository;
  private readonly reportUrlForRun: (runId: string) => string;
  private readonly matcher: MatcherService;

  constructor(
    repository: RunAlertRepository,
    reportUrlForRun: (runId: string) => string,
    matcher = new MatcherService()
  ) {
    this.repository = repository;
    this.reportUrlForRun = reportUrlForRun;
    this.matcher = matcher;
  }

  async evaluateRun(runId: string): Promise<RunAlertSummary> {
    return this.repository.withEvaluation(runId, async (unit) => {
      const complete = async (summary: RunAlertSummary): Promise<RunAlertSummary> => {
        await unit.ensureNotificationBatch(summary);
        return summary;
      };
      const data = unit.data;
      const rule = ruleFrom(data);
      const evaluated = data.snapshots.map((snapshot) =>
        persistenceDecision(snapshot, this.matcher.match(rule, rawOffer(snapshot)))
      );
      await unit.saveSnapshotDecisions(evaluated.map((entry) => entry.persistence));
      await unit.saveCandidateDecisions(candidateDecisions(evaluated));

      const combinationCandidates = evaluated.map((entry) => ({
        snapshotId: entry.snapshot.id,
        source: entry.snapshot.ownListingId ? "OWN" as const : "COMPETITOR" as const,
        platformItemId: entry.snapshot.platformItemId,
        skuId: entry.snapshot.skuId,
        shopName: entry.snapshot.shopName,
        searchRanks: [...entry.snapshot.searchRanks],
        stockState: entry.snapshot.stockState,
        priceConfidence: entry.snapshot.priceConfidence,
        payableFen: entry.snapshot.payableFen,
        combination: buildSkuCombination({
          productDecision: entry.persistence.decision,
          brand: data.model.brand,
          standardModel: data.model.standardModel,
          version: data.model.version,
          colorComparable: data.model.colorComparable,
          title: entry.snapshot.title,
          skuText: entry.snapshot.skuText,
          attributes: entry.snapshot.attributes,
          components: entry.snapshot.components
        })
      }));
      const comparison = evaluateRunSkuCombinations({
        candidates: combinationCandidates,
        ownCatalogComplete: data.ownCatalogComplete
      });
      const combinationDecisions = evaluated.map((entry): SnapshotCombinationPersistence => {
        const decision = comparison.bySnapshotId.get(entry.snapshot.id)!;
        return {
          snapshotId: decision.snapshotId,
          signature: decision.signature,
          label: decision.label,
          state: decision.state,
          comparisonOwnSnapshotId: decision.comparisonOwnSnapshotId,
          reasons: {
            ruleVersion: "sku-combination-v1",
            codes: [...decision.reasons]
          }
        };
      });
      await unit.saveCombinationDecisions(combinationDecisions);
      await unit.saveOwnBaselineSnapshot(comparison.primaryOwnSnapshotId);

      const snapshotById = new Map(data.snapshots.map((snapshot) => [snapshot.id, snapshot]));
      const primaryOwnSnapshot = comparison.primaryOwnSnapshotId === null
        ? null
        : snapshotById.get(comparison.primaryOwnSnapshotId) ?? null;
      const missingOwnGroups: RunAlertMissingOwnGroup[] = comparison.missingOwnGroups.map((group) => {
        const representative = group.offerSnapshotIds
          .flatMap((snapshotId) => snapshotById.get(snapshotId) ?? [])
          .sort(compareRepresentative)[0];
        return {
          combinationSignature: group.combinationSignature,
          combinationLabel: group.combinationLabel,
          missingReason: group.missingReason,
          earliestRank: group.earliestRank,
          minimumConfirmedPayableFen: group.minimumConfirmedPayableFen,
          shopCount: group.shops.length,
          representativeUrl: representative?.url ?? ""
        };
      });
      const competitorSnapshots = data.snapshots.filter((snapshot) => snapshot.searchCandidateId !== null);
      const common = {
        runId: data.runId,
        monitoredModelId: data.model.id,
        brand: data.model.brand,
        standardModel: data.model.standardModel,
        comparisonType: data.model.comparisonType,
        owner: data.model.owner,
        completedAt: data.completedAt,
        checkedItemCount: new Set(competitorSnapshots.map((snapshot) => snapshot.platformItemId)).size,
        positionCount: data.positionCount,
        shopCount: new Set(competitorSnapshots.map((snapshot) => snapshot.shopName)).size,
        searchLimit: data.searchLimit,
        skuCount: data.skuCount,
        reviewCount: comparison.reviewCount,
        reportUrl: this.reportUrlForRun(data.runId),
        baseline: primaryOwnSnapshot === null ? null : baselineSummary(primaryOwnSnapshot),
        missingOwnGroups
      };
      const claimedOwnSnapshotExists = data.snapshots.some((snapshot) =>
        snapshot.ownListingId !== null
        && data.claimedOwnListingIds.includes(snapshot.ownListingId)
      );
      if (!claimedOwnSnapshotExists) {
        const issueCreated = await unit.ensureBaselineIssue("OWN_BASELINE_MISSING");
        return complete({
          ...common,
          issueCount: data.issueCount + (issueCreated ? 1 : 0),
          systemIssue: "OWN_BASELINE_MISSING",
          alerts: []
        });
      }

      const alertService = new AlertService(unit.alerts);
      const alerts: RunAlertEntry[] = [];
      for (const alertCandidate of comparison.alertCandidates) {
        const competitor = snapshotById.get(alertCandidate.snapshotId);
        const own = snapshotById.get(alertCandidate.comparisonOwnSnapshotId);
        const combinationDecision = comparison.bySnapshotId.get(alertCandidate.snapshotId);
        const evaluatedCompetitor = evaluated.find((entry) => entry.snapshot.id === alertCandidate.snapshotId);
        if (!competitor || !own || !combinationDecision || !evaluatedCompetitor) continue;
        const category = evaluatedCompetitor.persistence.decision;
        if (category !== "BARE" && category !== "BUNDLE") continue;
        const persisted = await alertService.evaluate(
          alertOffer(data, own, alertCandidate.signature),
          alertOffer(data, competitor, alertCandidate.signature),
          {
            category,
            comparable: true,
            bundleConfiguration: category === "BUNDLE" ? "SAME" : "NOT_APPLICABLE",
            reasons: [...combinationDecision.reasons]
          }
        );
        if (!persisted || persisted.severity !== "CONFIRMED_LOW" || competitor.payableFen === null) continue;
        alerts.push({
          alertId: persisted.id,
          severity: "CONFIRMED_LOW",
          snapshotId: competitor.id,
          ownSnapshotId: own.id,
          ownSkuText: own.skuText,
          ownPayableFen: alertCandidate.ownPayableFen,
          combinationSignature: alertCandidate.signature,
          combinationLabel: alertCandidate.label,
          rank: earliestRank(competitor),
          shopName: competitor.shopName,
          title: competitor.title,
          skuText: competitor.skuText,
          activityPriceFen: competitor.activityPriceFen,
          publicDiscountFen: competitor.publicDiscountFen,
          payableFen: competitor.payableFen,
          differenceFen: alertCandidate.differenceFen,
          url: competitor.url,
          reasons: [...combinationDecision.reasons]
        });
      }

      return complete({
        ...common,
        issueCount: data.issueCount,
        systemIssue: null,
        alerts
      });
    });
  }
}
