import { bundleSignature } from "../pricing/bundle-signature.ts";
import { AlertService, type AlertRepository } from "../alerts/alert.service.ts";
import { MatcherService, normalizeText } from "../matching/matcher.service.ts";
import type { MatchDecision, MonitoredProductRule } from "../matching/matcher.types.ts";
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
  bundleComponents: RunAlertBundleComponent[] | null;
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
  model: {
    id: string;
    brand: string;
    standardModel: string;
    version: string | null;
    comparisonType: "BARE" | "BUNDLE";
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

export interface RunAlertUnitOfWork {
  data: RunAlertData;
  alerts: AlertRepository;
  saveSnapshotDecisions(decisions: SnapshotMatchPersistence[]): Promise<void>;
  saveCandidateDecisions(decisions: CandidateMatchPersistence[]): Promise<void>;
  saveOwnBaselineSnapshot(snapshotId: string | null): Promise<void>;
  ensureBaselineIssue(code: BaselineIssueCode): Promise<boolean>;
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

export interface RunAlertSummary {
  runId: string;
  monitoredModelId: string;
  brand: string;
  standardModel: string;
  comparisonType: "BARE" | "BUNDLE";
  owner: string;
  completedAt: Date;
  checkedItemCount: number;
  searchLimit: number;
  skuCount: number;
  issueCount: number;
  reportUrl: string;
  baseline: RunAlertBaseline | null;
  systemIssue: BaselineIssueCode | null;
  alerts: RunAlertEntry[];
}

interface EvaluatedSnapshot {
  snapshot: RunAlertSnapshot;
  rawDecision: MatchDecision;
  persistence: SnapshotMatchPersistence;
  bundleConfiguration: "SAME" | "DIFFERENT" | "UNKNOWN" | "NOT_APPLICABLE";
}

function compact(value: string): string {
  return normalizeText(value).replace(/\s+/g, "");
}

function configuredSkuMatches(snapshot: RunAlertSnapshot): boolean {
  if (!snapshot.ownListingSkuText) return false;
  const target = compact(snapshot.ownListingSkuText);
  if (!target) return false;
  const values = Object.values(snapshot.attributes);
  const candidates = [snapshot.skuText, ...values, values.join(" ")];
  return candidates.some((candidate) => compact(candidate) === target);
}

function configuredBundleSignature(items: RunAlertBundleItem[]): string | null {
  const coreItems = items.some((item) => item.core) ? items.filter((item) => item.core) : items;
  return coreItems.length === 0
    ? null
    : bundleSignature(coreItems.map((item) => ({ ...item, unitValueFen: 0 })));
}

function observedBundleSignature(components: RunAlertBundleComponent[] | null): string | null {
  if (!components || components.length === 0) return null;
  return bundleSignature(components.map((component) => ({
    ...component,
    unitValueFen: 0,
    core: true
  })));
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

function persistenceDecision(
  data: RunAlertData,
  snapshot: RunAlertSnapshot,
  rawDecision: MatchDecision
): EvaluatedSnapshot {
  let exact = rawDecision.comparable;
  let bundleConfiguration: EvaluatedSnapshot["bundleConfiguration"] = "NOT_APPLICABLE";
  const reasons = [...rawDecision.reasons];

  if (data.model.comparisonType === "BUNDLE" && rawDecision.category !== "REJECTED") {
    const configuredSignature = configuredBundleSignature(data.model.bundleItems);
    const observedSignature = observedBundleSignature(snapshot.bundleComponents);
    const exactBundle = configuredSignature !== null && observedSignature === configuredSignature;
    bundleConfiguration = exactBundle ? "SAME" : observedSignature === null ? "UNKNOWN" : "DIFFERENT";
    exact = rawDecision.category === "BUNDLE" && exactBundle;
    reasons.push(
      exactBundle
        ? `套装核心配件签名一致：${configuredSignature}`
        : observedSignature === null
          ? "缺少可验证的结构化套装配件，进入人工复核"
          : "套装核心配件签名不同，进入人工复核"
    );
  } else if (rawDecision.category === "BUNDLE") {
    bundleConfiguration = "DIFFERENT";
  }

  const decision: PersistedMatchDecision = rawDecision.category === "REJECTED"
    ? "REJECTED"
    : exact && (rawDecision.category === "BARE" || rawDecision.category === "BUNDLE")
      ? rawDecision.category
      : "MANUAL";

  return {
    snapshot,
    rawDecision,
    bundleConfiguration,
    persistence: {
      snapshotId: snapshot.id,
      decision,
      comparable: decision === data.model.comparisonType,
      confidenceBps: Math.round(rawDecision.confidence * 10_000),
      normalizedModel: rawDecision.normalizedModel,
      reasons
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
      reasons: selected.persistence.reasons
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
      const data = unit.data;
      const rule = ruleFrom(data);
      const evaluated = data.snapshots.map((snapshot) =>
        persistenceDecision(data, snapshot, this.matcher.match(rule, rawOffer(snapshot)))
      );

      await unit.saveSnapshotDecisions(evaluated.map((entry) => entry.persistence));
      await unit.saveCandidateDecisions(candidateDecisions(evaluated));

      const ownBaselines = evaluated.filter((entry) =>
        entry.snapshot.ownListingId !== null
        && configuredSkuMatches(entry.snapshot)
        && entry.persistence.comparable
        && entry.snapshot.stockState === "IN_STOCK"
        && entry.snapshot.priceConfidence === "CONFIRMED"
        && entry.snapshot.payableFen !== null
      );

      const checkedItemCount = new Set(
        data.snapshots
          .filter((snapshot) => snapshot.searchCandidateId !== null)
          .map((snapshot) => snapshot.platformItemId)
      ).size;
      const common = {
        runId: data.runId,
        monitoredModelId: data.model.id,
        brand: data.model.brand,
        standardModel: data.model.standardModel,
        comparisonType: data.model.comparisonType,
        owner: data.model.owner,
        completedAt: data.completedAt,
        checkedItemCount,
        searchLimit: data.searchLimit,
        skuCount: data.skuCount,
        reportUrl: this.reportUrlForRun(data.runId)
      };

      if (ownBaselines.length !== 1) {
        await unit.saveOwnBaselineSnapshot(null);
        const systemIssue: BaselineIssueCode = ownBaselines.length === 0
          ? "OWN_BASELINE_MISSING"
          : "OWN_BASELINE_AMBIGUOUS";
        const issueCreated = await unit.ensureBaselineIssue(systemIssue);
        return {
          ...common,
          issueCount: data.issueCount + (issueCreated ? 1 : 0),
          baseline: null,
          systemIssue,
          alerts: []
        };
      }

      const baseline = ownBaselines[0]!;
      await unit.saveOwnBaselineSnapshot(baseline.snapshot.id);
      const alertService = new AlertService(unit.alerts);
      const alerts: RunAlertEntry[] = [];
      for (const entry of evaluated) {
        const competitor = entry.snapshot;
        if (!competitor.searchCandidateId) continue;
        const persisted = await alertService.evaluate(
          {
            monitoredModelId: data.model.id,
            snapshotId: baseline.snapshot.id,
            platformItemId: baseline.snapshot.platformItemId,
            skuId: baseline.snapshot.skuId,
            brand: data.model.brand,
            standardModel: data.model.standardModel,
            comparisonType: data.model.comparisonType,
            shopName: baseline.snapshot.shopName,
            skuText: baseline.snapshot.skuText,
            payableFen: baseline.snapshot.payableFen,
            priceConfidence: baseline.snapshot.priceConfidence,
            stockState: baseline.snapshot.stockState,
            url: baseline.snapshot.url,
            capturedAt: baseline.snapshot.capturedAt,
            owner: data.model.owner
          },
          {
            monitoredModelId: data.model.id,
            snapshotId: competitor.id,
            platformItemId: competitor.platformItemId,
            skuId: competitor.skuId,
            brand: data.model.brand,
            standardModel: data.model.standardModel,
            comparisonType: data.model.comparisonType,
            shopName: competitor.shopName,
            skuText: competitor.skuText,
            payableFen: competitor.payableFen,
            priceConfidence: competitor.priceConfidence,
            stockState: competitor.stockState,
            url: competitor.url,
            capturedAt: competitor.capturedAt,
            owner: data.model.owner
          },
          {
            category: entry.rawDecision.category === "BUNDLE" ? "BUNDLE" : entry.persistence.decision,
            comparable: entry.persistence.comparable,
            bundleConfiguration: entry.bundleConfiguration,
            reasons: entry.persistence.reasons
          }
        );
        if (!persisted || competitor.payableFen === null) continue;
        alerts.push({
          alertId: persisted.id,
          severity: persisted.severity,
          snapshotId: competitor.id,
          rank: competitor.searchRanks.length > 0 ? Math.min(...competitor.searchRanks) : null,
          shopName: competitor.shopName,
          title: competitor.title,
          skuText: competitor.skuText,
          activityPriceFen: competitor.activityPriceFen,
          publicDiscountFen: competitor.publicDiscountFen,
          payableFen: competitor.payableFen,
          differenceFen: persisted.differenceFen,
          url: competitor.url,
          reasons: entry.persistence.reasons
        });
      }

      return {
        ...common,
        issueCount: data.issueCount,
        baseline: baselineSummary(baseline.snapshot),
        systemIssue: null,
        alerts
      };
    });
  }
}
