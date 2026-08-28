import { tmpdir } from "node:os";
import { resolve } from "node:path";

import type {
  CollectedItem,
  CollectedSku,
  CollectedSkuComponent,
  CollectorJob,
  CollectorReport
} from "../../../packages/contracts/src/index.ts";
import type {
  AlertRepository,
  PriceAlertRecord
} from "../../../apps/api/src/alerts/alert.service.ts";
import {
  RunAlertNotifier,
  type ClaimedRunAlertBatch,
  type RunAlertNotificationRepository,
  type StoredRunAlertNotificationBatch
} from "../../../apps/api/src/alerts/run-alert-notifier.ts";
import {
  RunAlertReconciler,
  type ClaimedRunAlertEvaluation,
  type RunAlertEvaluationRepository
} from "../../../apps/api/src/alerts/run-alert-reconciler.ts";
import type { WecomMarkdownSender } from "../../../apps/api/src/alerts/wecom/wecom.client.ts";
import {
  CollectorAgentService,
  type CollectorAgentRepository
} from "../../../apps/api/src/collector-agent/collector-agent.service.ts";
import { CollectionEvidenceStore } from "../../../apps/api/src/collection/collection-evidence-store.ts";
import {
  desktopReportDigest,
  DesktopReportConflictError,
  DesktopReportIngestionService,
  type ClaimedDesktopRun,
  type DesktopReportRepository,
  type IngestionSummary
} from "../../../apps/api/src/collection/desktop-report-ingestion.service.ts";
import {
  RunAlertService,
  type BaselineIssueCode,
  type CandidateMatchPersistence,
  type RunAlertData,
  type RunAlertRepository,
  type RunAlertSummary,
  type RunAlertUnitOfWork,
  type SnapshotCombinationPersistence,
  type SnapshotMatchPersistence
} from "../../../apps/api/src/collection/run-alert.service.ts";
import {
  aggregateCollectionRunReport,
  type CollectionRunBusinessAggregationInput,
  type CollectionRunBusinessPositionFact,
  type CollectionRunBusinessSections,
  type CollectionRunBusinessSnapshotFact
} from "../../../apps/api/src/operations/collection-report-aggregation.ts";

const AGENT_ID = "desktop-fixture-agent";
const AGENT_TOKEN = "test-desktop-fixture-token";
const CAPTURED_AT = "2026-08-28T01:30:00.000Z";
const COMPLETED_AT = "2026-08-28T01:31:00.000Z";

export interface DesktopCombinationOfferFixture {
  itemId: string;
  skuId: string;
  payableFen: number;
  components: CollectedSkuComponent[];
}

export interface DesktopCombinationCompetitorFixture extends DesktopCombinationOfferFixture {
  ranks: number[];
}

export interface DesktopCombinationRunFixture {
  own: DesktopCombinationOfferFixture[];
  competitors: DesktopCombinationCompetitorFixture[];
}

export interface DesktopReportHarnessOptions {
  wecomLiveSendingApproved?: boolean;
}

export interface DesktopCombinationRunResult {
  ingestion: IngestionSummary;
  report: CollectionRunBusinessSections;
  alerts: PriceAlertRecord[];
  notificationBatch: StoredRunAlertNotificationBatch;
  notificationBatchCount: number;
  sentMessages: string[];
}

class InMemoryAlertRepository implements AlertRepository {
  readonly alerts: PriceAlertRecord[] = [];

  async createIfAbsent(input: Omit<PriceAlertRecord, "id" | "notifiedAt">) {
    if (this.alerts.some((alert) => alert.dedupKey === input.dedupKey)) return null;
    const alert: PriceAlertRecord = {
      ...input,
      id: `desktop-alert-${this.alerts.length + 1}`,
      notifiedAt: null
    };
    this.alerts.push(alert);
    return alert;
  }

  async markBatchNotified(ids: string[], notifiedAt: Date) {
    for (const alert of this.alerts) {
      if (ids.includes(alert.id)) alert.notifiedAt = notifiedAt;
    }
  }

  async recordBatchNotificationFailure() {}
}

interface StoredBatchRecord {
  batchId: string;
  state: StoredRunAlertNotificationBatch["state"];
  summary: RunAlertSummary;
  attemptToken: string | null;
}

class InMemoryNotificationRepository implements RunAlertNotificationRepository {
  readonly batches = new Map<string, StoredBatchRecord>();

  ensureBatch(summary: RunAlertSummary): void {
    if (this.batches.has(summary.runId)) return;
    this.batches.set(summary.runId, {
      batchId: `desktop-batch-${this.batches.size + 1}`,
      state: "PENDING",
      summary: structuredClone(summary),
      attemptToken: null
    });
  }

  async getBatch(runId: string): Promise<StoredRunAlertNotificationBatch | null> {
    const batch = this.batches.get(runId);
    return batch ? {
      batchId: batch.batchId,
      runId,
      state: batch.state,
      summary: structuredClone(batch.summary)
    } : null;
  }

  async claimBatch(runId: string): Promise<ClaimedRunAlertBatch | null> {
    const batch = this.batches.get(runId);
    if (!batch || batch.state !== "PENDING") return null;
    batch.state = "SENDING";
    batch.attemptToken = `desktop-attempt-${runId}`;
    return {
      batchId: batch.batchId,
      attemptToken: batch.attemptToken,
      summary: structuredClone(batch.summary),
      alertIds: batch.summary.alerts.map((alert) => alert.alertId)
    };
  }

  async markBatchNotified(batch: ClaimedRunAlertBatch): Promise<void> {
    const stored = this.requireClaim(batch);
    stored.state = "NOTIFIED";
    stored.attemptToken = null;
  }

  async recordBatchNotificationFailure(batch: ClaimedRunAlertBatch): Promise<void> {
    const stored = this.requireClaim(batch);
    stored.state = "PENDING";
    stored.attemptToken = null;
  }

  async recordBatchNotificationAmbiguous(batch: ClaimedRunAlertBatch): Promise<void> {
    const stored = this.requireClaim(batch);
    stored.state = "AMBIGUOUS";
    stored.attemptToken = null;
  }

  async listRetryableSummaries(_attemptedAt: Date, limit: number): Promise<RunAlertSummary[]> {
    return [...this.batches.values()]
      .filter((batch) => batch.state === "PENDING")
      .slice(0, limit)
      .map((batch) => structuredClone(batch.summary));
  }

  private requireClaim(batch: ClaimedRunAlertBatch): StoredBatchRecord {
    const stored = [...this.batches.values()].find((candidate) => candidate.batchId === batch.batchId);
    if (!stored || stored.state !== "SENDING" || stored.attemptToken !== batch.attemptToken) {
      throw new Error("Desktop fixture notification claim is invalid");
    }
    return stored;
  }
}

class RecordingSender implements WecomMarkdownSender {
  readonly messages: string[] = [];

  async sendMarkdown(message: string) {
    this.messages.push(message);
  }
}

class InMemoryCollectorAgentRepository implements CollectorAgentRepository {
  private readonly runId: string;

  constructor(runId: string) {
    this.runId = runId;
  }

  async createAgent(input: { name: string }) {
    return { id: AGENT_ID, name: input.name };
  }

  async authenticate(token: string) {
    return token === AGENT_TOKEN ? { id: AGENT_ID, enabled: true } : null;
  }

  async claimNext(): Promise<CollectorJob | null> {
    return null;
  }

  async heartbeat() {
    return false;
  }

  async pause() {
    return false;
  }

  async release() {
    return false;
  }

  async ownsRun(agentId: string, runId: string) {
    return agentId === AGENT_ID && runId === this.runId;
  }
}

class InMemoryEvaluationRepository implements RunAlertEvaluationRepository {
  private readonly runId: string;
  private readonly isReady: () => boolean;
  private inFlight = false;
  private evaluated = false;

  constructor(runId: string, isReady: () => boolean) {
    this.runId = runId;
    this.isReady = isReady;
  }

  async claimRun(runId: string | null): Promise<ClaimedRunAlertEvaluation | null> {
    if (!this.isReady() || this.inFlight || this.evaluated || (runId !== null && runId !== this.runId)) {
      return null;
    }
    this.inFlight = true;
    return { runId: this.runId, attemptToken: `desktop-evaluation-${this.runId}` };
  }

  async markEvaluated(claim: ClaimedRunAlertEvaluation): Promise<void> {
    this.assertClaim(claim);
    this.inFlight = false;
    this.evaluated = true;
  }

  async recordEvaluationFailure(claim: ClaimedRunAlertEvaluation): Promise<void> {
    this.assertClaim(claim);
    this.inFlight = false;
  }

  private assertClaim(claim: ClaimedRunAlertEvaluation): void {
    if (!this.inFlight || claim.runId !== this.runId) {
      throw new Error("Desktop fixture evaluation claim is invalid");
    }
  }
}

interface WorkflowStoreOptions {
  report: CollectorReport;
  claimedOwnListingIds: string[];
  alertRepository: InMemoryAlertRepository;
  notificationRepository: InMemoryNotificationRepository;
}

class InMemoryWorkflowStore implements DesktopReportRepository, RunAlertRepository {
  private readonly claimedRun: ClaimedDesktopRun;
  private readonly alertRepository: InMemoryAlertRepository;
  private readonly notificationRepository: InMemoryNotificationRepository;
  private readonly expectedReport: CollectorReport;
  private acceptedDigest: string | null = null;
  private ingestionSummary: IngestionSummary | null = null;
  private runData: RunAlertData | null = null;
  private readonly positions: CollectionRunBusinessPositionFact[] = [];
  private readonly snapshots = new Map<string, CollectionRunBusinessSnapshotFact>();
  private readonly baselineIssues = new Set<BaselineIssueCode>();

  constructor(options: WorkflowStoreOptions) {
    this.expectedReport = options.report;
    this.alertRepository = options.alertRepository;
    this.notificationRepository = options.notificationRepository;
    this.claimedRun = {
      runId: options.report.runId,
      agentId: AGENT_ID,
      monitoredModelId: "model-rode-nt1s",
      providerKey: "taobao-desktop",
      searchLimit: options.report.searchLimit,
      status: "RUNNING",
      ownListingIds: [...options.claimedOwnListingIds]
    };
  }

  hasTerminalData(): boolean {
    return this.runData !== null;
  }

  async inspectRun(agentId: string, runId: string): Promise<ClaimedDesktopRun | null> {
    return agentId === AGENT_ID && runId === this.claimedRun.runId
      ? { ...this.claimedRun, ownListingIds: [...this.claimedRun.ownListingIds] }
      : null;
  }

  async withEvidenceRunLock<T>(
    agentId: string,
    runId: string,
    operation: (mode: "CREATE_OR_REPLAY" | "REPLAY_ONLY") => Promise<T>
  ): Promise<T> {
    if (agentId !== AGENT_ID || runId !== this.claimedRun.runId) throw new DesktopReportConflictError();
    return operation(this.claimedRun.status === "RUNNING" ? "CREATE_OR_REPLAY" : "REPLAY_ONLY");
  }

  async ingest(_agentId: string, report: CollectorReport, verifyEvidence: () => Promise<void>) {
    await verifyEvidence();
    const digest = desktopReportDigest(report);
    if (this.acceptedDigest !== null) {
      if (digest !== this.acceptedDigest || !this.ingestionSummary) throw new DesktopReportConflictError();
      return { summary: structuredClone(this.ingestionSummary), newlyAccepted: false };
    }
    if (desktopReportDigest(this.expectedReport) !== digest) throw new DesktopReportConflictError();
    if (report.status !== "SUCCEEDED" && report.status !== "PARTIAL_FAILED" && report.status !== "FAILED") {
      throw new DesktopReportConflictError();
    }

    this.persistReport(report);
    this.claimedRun.status = report.status;
    this.acceptedDigest = digest;
    this.ingestionSummary = this.buildIngestionSummary(report);
    return { summary: structuredClone(this.ingestionSummary), newlyAccepted: true };
  }

  async recordSystemError() {}

  async withEvaluation<T>(runId: string, operation: (unit: RunAlertUnitOfWork) => Promise<T>): Promise<T> {
    if (runId !== this.claimedRun.runId || !this.runData) {
      throw new Error("Desktop fixture run is not ready for alert evaluation");
    }
    const unit: RunAlertUnitOfWork = {
      data: this.runData,
      alerts: this.alertRepository,
      saveSnapshotDecisions: async (decisions) => this.saveSnapshotDecisions(decisions),
      saveCandidateDecisions: async (decisions) => this.saveCandidateDecisions(decisions),
      saveCombinationDecisions: async (decisions) => this.saveCombinationDecisions(decisions),
      saveOwnBaselineSnapshot: async (snapshotId) => this.saveOwnBaselineSnapshot(snapshotId),
      ensureBaselineIssue: async (code) => this.ensureBaselineIssue(code),
      ensureNotificationBatch: async (summary) => this.notificationRepository.ensureBatch(summary)
    };
    return operation(unit);
  }

  aggregationInput(): CollectionRunBusinessAggregationInput {
    return {
      claimedOwnListingIds: [...this.claimedRun.ownListingIds],
      positions: this.positions.map((position) => ({ ...position })),
      snapshots: [...this.snapshots.values()].map((snapshot) => structuredClone(snapshot))
    };
  }

  private persistReport(report: CollectorReport): void {
    this.positions.push(...report.positions.map((position) => ({
      ...position,
      capturedAt: new Date(position.capturedAt)
    })));
    const ranksByItem = new Map<string, number[]>();
    for (const position of report.positions) {
      const ranks = ranksByItem.get(position.platformItemId) ?? [];
      ranks.push(position.rank);
      ranksByItem.set(position.platformItemId, ranks);
    }

    const runSnapshots: RunAlertData["snapshots"] = [];
    for (const item of report.ownItems) {
      for (const sku of item.skus) {
        runSnapshots.push(this.persistSnapshot(item, sku, item.ownListingId, null, ranksByItem));
      }
    }
    for (const item of report.competitorItems) {
      const candidateId = `candidate:${item.platformItemId}`;
      for (const sku of item.skus) {
        runSnapshots.push(this.persistSnapshot(item, sku, null, candidateId, ranksByItem));
      }
    }

    const collectedOwnListingIds = new Set(runSnapshots.flatMap((snapshot) =>
      snapshot.ownListingId ? [snapshot.ownListingId] : []));
    this.runData = {
      runId: report.runId,
      status: report.status as RunAlertData["status"],
      searchLimit: report.searchLimit,
      positionCount: report.positions.length,
      skuCount: runSnapshots.length,
      issueCount: report.issues.length,
      completedAt: new Date(report.completedAt),
      claimedOwnListingIds: [...this.claimedRun.ownListingIds],
      ownCatalogComplete: this.claimedRun.ownListingIds.length > 0
        && this.claimedRun.ownListingIds.every((id) => collectedOwnListingIds.has(id)),
      model: {
        id: this.claimedRun.monitoredModelId,
        brand: "RODE",
        standardModel: "NT1S",
        version: null,
        comparisonType: "BARE",
        colorComparable: false,
        owner: "fixture-operator",
        effectiveAliases: ["NT1S"],
        excludedAliases: [],
        mustIncludeTerms: [],
        excludedTerms: [],
        bundleItems: []
      },
      snapshots: runSnapshots
    };
  }

  private persistSnapshot(
    item: CollectedItem,
    sku: CollectedSku,
    ownListingId: string | null,
    searchCandidateId: string | null,
    ranksByItem: Map<string, number[]>
  ): RunAlertData["snapshots"][number] {
    if (this.snapshots.has(sku.skuId)) {
      throw new Error(`Desktop fixture SKU ids must be globally unique: ${sku.skuId}`);
    }
    const components = sku.components?.map((component) => ({ ...component })) ?? null;
    const publicDiscountFen = sku.couponDiscountFen + sku.fullReductionFen + sku.directDiscountFen;
    this.snapshots.set(sku.skuId, {
      id: sku.skuId,
      ownListingId,
      platformItemId: item.platformItemId,
      skuId: sku.skuId,
      shopName: item.shopName,
      title: item.title,
      skuText: sku.label,
      url: item.url,
      attributes: { ...sku.attributes },
      components,
      promotions: sku.promotions.map((promotion) => ({ ...promotion })),
      gifts: [],
      listPriceFen: sku.listPriceFen,
      activityPriceFen: sku.activityPriceFen,
      couponDiscountFen: sku.couponDiscountFen,
      fullReductionFen: sku.fullReductionFen,
      directDiscountFen: sku.directDiscountFen,
      mandatoryFeeFen: sku.mandatoryFeeFen,
      publicDiscountFen,
      payableFen: sku.payableFen,
      priceConfidence: sku.priceConfidence,
      stockState: sku.stockState,
      matchCategory: "REVIEW",
      matchDecision: null,
      comparable: false,
      matchConfidenceBps: 0,
      matchReasons: [],
      combinationSignature: null,
      combinationLabel: null,
      combinationState: null,
      combinationReasons: [],
      comparisonOwnSnapshotId: null,
      evidenceKey: sku.evidenceKey,
      capturedAt: new Date(sku.capturedAt)
    });
    return {
      id: sku.skuId,
      ownListingId,
      ownListingSkuText: ownListingId ? sku.label : null,
      searchCandidateId,
      platformItemId: item.platformItemId,
      skuId: sku.skuId,
      shopName: item.shopName,
      title: item.title,
      skuText: sku.label,
      attributes: { ...sku.attributes },
      components,
      listPriceFen: sku.listPriceFen,
      activityPriceFen: sku.activityPriceFen,
      publicDiscountFen,
      payableFen: sku.payableFen,
      priceConfidence: sku.priceConfidence,
      stockState: sku.stockState,
      capturedAt: new Date(sku.capturedAt),
      url: item.url,
      searchRanks: [...(ranksByItem.get(item.platformItemId) ?? [])]
    };
  }

  private buildIngestionSummary(report: CollectorReport): IngestionSummary {
    const facts = [...this.snapshots.values()];
    return {
      runId: report.runId,
      status: report.status as IngestionSummary["status"],
      positionCount: report.positions.length,
      uniqueItemCount: new Set(report.positions.map((position) => position.platformItemId)).size,
      skuCount: facts.length,
      issueCount: report.issues.length,
      ownSnapshotIds: facts.filter((snapshot) => snapshot.ownListingId !== null).map((snapshot) => snapshot.id),
      competitorSnapshotIds: facts.filter((snapshot) => snapshot.ownListingId === null).map((snapshot) => snapshot.id)
    };
  }

  private saveSnapshotDecisions(decisions: SnapshotMatchPersistence[]): void {
    for (const decision of decisions) {
      const snapshot = this.requireSnapshot(decision.snapshotId);
      snapshot.matchDecision = decision.decision;
      snapshot.comparable = decision.comparable;
      snapshot.matchConfidenceBps = decision.confidenceBps;
      snapshot.matchReasons = [...decision.reasons];
      snapshot.matchCategory = decision.decision === "REJECTED"
        ? "EXCLUDED"
        : decision.comparable && decision.decision === this.runData?.model.comparisonType
          ? "EXACT"
          : "REVIEW";
    }
  }

  private saveCandidateDecisions(_decisions: CandidateMatchPersistence[]): void {}

  private saveCombinationDecisions(decisions: SnapshotCombinationPersistence[]): void {
    for (const decision of decisions) {
      const snapshot = this.requireSnapshot(decision.snapshotId);
      snapshot.combinationSignature = decision.signature;
      snapshot.combinationLabel = decision.label;
      snapshot.combinationState = decision.state;
      snapshot.combinationReasons = [...decision.reasons.codes];
      snapshot.comparisonOwnSnapshotId = decision.comparisonOwnSnapshotId;
    }
  }

  private saveOwnBaselineSnapshot(snapshotId: string | null): void {
    if (snapshotId !== null) this.requireSnapshot(snapshotId);
  }

  private ensureBaselineIssue(code: BaselineIssueCode): boolean {
    if (this.baselineIssues.has(code)) return false;
    this.baselineIssues.add(code);
    if (this.runData) this.runData.issueCount += 1;
    return true;
  }

  private requireSnapshot(snapshotId: string): CollectionRunBusinessSnapshotFact {
    const snapshot = this.snapshots.get(snapshotId);
    if (!snapshot) throw new Error(`Desktop fixture snapshot is missing: ${snapshotId}`);
    return snapshot;
  }
}

function fixtureUrl(itemId: string): string {
  return `https://item.taobao.com/item.htm?id=${encodeURIComponent(itemId)}`;
}

function fixtureSku(input: DesktopCombinationOfferFixture): CollectedSku {
  return {
    skuId: input.skuId,
    label: `RODE NT1S 单机 ${input.skuId}`,
    attributes: {},
    components: input.components.map((component) => ({ ...component })),
    stockState: "IN_STOCK",
    listPriceFen: input.payableFen,
    activityPriceFen: input.payableFen,
    couponDiscountFen: 0,
    fullReductionFen: 0,
    directDiscountFen: 0,
    promotions: [],
    mandatoryFeeFen: 0,
    priceConfidence: "CONFIRMED",
    payableFen: input.payableFen,
    capturedAt: CAPTURED_AT,
    evidenceKey: null
  };
}

function desktopUiFixture(
  runNumber: number,
  input: DesktopCombinationRunFixture
): { report: CollectorReport; claimedOwnListingIds: string[] } {
  if (input.own.length === 0 || input.competitors.length === 0) {
    throw new Error("Desktop fixture requires own and competitor offers");
  }
  const ranks = new Map<number, DesktopCombinationCompetitorFixture>();
  for (const competitor of input.competitors) {
    for (const rank of competitor.ranks) {
      if (!Number.isSafeInteger(rank) || rank <= 0 || rank > 50 || ranks.has(rank)) {
        throw new Error(`Desktop fixture rank is invalid or duplicated: ${rank}`);
      }
      ranks.set(rank, competitor);
    }
  }
  const searchLimit = Math.max(...ranks.keys());
  const runId = `desktop-combination-run-${runNumber}`;
  const claimedOwnListingIds = input.own.map((offer) => `own-listing:${offer.itemId}`);
  const positions = Array.from({ length: searchLimit }, (_, index) => {
    const rank = index + 1;
    const competitor = ranks.get(rank);
    const itemId = competitor?.itemId ?? `fixture-position-${rank}`;
    const payableFen = competitor?.payableFen ?? 0;
    return {
      rank,
      platformItemId: itemId,
      url: fixtureUrl(itemId),
      shopName: competitor ? `Competitor ${competitor.itemId}` : "Fixture Position",
      title: competitor ? `RODE NT1S ${competitor.skuId}` : "Fixture position without an offer",
      displayPriceMinFen: payableFen,
      displayPriceMaxFen: payableFen,
      sponsored: false,
      capturedAt: CAPTURED_AT
    };
  });
  const report: CollectorReport = {
    schemaVersion: 1,
    runId,
    collectorId: AGENT_ID,
    appVersion: "fixture-1.0.0",
    startedAt: CAPTURED_AT,
    completedAt: COMPLETED_AT,
    status: "SUCCEEDED",
    searchLimit,
    searchTerminationReason: "LIMIT_REACHED",
    positions,
    ownItems: input.own.map((offer, index) => ({
      ownListingId: claimedOwnListingIds[index]!,
      platformItemId: offer.itemId,
      url: fixtureUrl(offer.itemId),
      shopName: "Fixture Own Shop",
      title: `RODE NT1S ${offer.skuId}`,
      searchRanks: [],
      skus: [fixtureSku(offer)]
    })),
    competitorItems: input.competitors.map((offer) => ({
      platformItemId: offer.itemId,
      url: fixtureUrl(offer.itemId),
      shopName: `Competitor ${offer.itemId}`,
      title: `RODE NT1S ${offer.skuId}`,
      searchRanks: [...offer.ranks],
      skus: [fixtureSku(offer)]
    })),
    issues: []
  };
  return { report, claimedOwnListingIds };
}

export function createDesktopReportHarness(options: DesktopReportHarnessOptions = {}) {
  const wecomLiveSendingApproved = options.wecomLiveSendingApproved ?? false;
  let runNumber = 0;

  return {
    async collectDesktopCombinationRun(
      input: DesktopCombinationRunFixture
    ): Promise<DesktopCombinationRunResult> {
      runNumber += 1;
      const fixture = desktopUiFixture(runNumber, input);
      const alerts = new InMemoryAlertRepository();
      const notifications = new InMemoryNotificationRepository();
      const sender = new RecordingSender();
      const store = new InMemoryWorkflowStore({
        report: fixture.report,
        claimedOwnListingIds: fixture.claimedOwnListingIds,
        alertRepository: alerts,
        notificationRepository: notifications
      });
      const evaluator = new RunAlertService(
        store,
        (runId) => `https://monitor.example.test/collection-runs/${runId}`
      );
      const notifier = new RunAlertNotifier(
        notifications,
        async () => sender,
        async () => wecomLiveSendingApproved,
        () => new Date(COMPLETED_AT)
      );
      const evaluationRepository = new InMemoryEvaluationRepository(
        fixture.report.runId,
        () => store.hasTerminalData()
      );
      const reconciler = new RunAlertReconciler(
        evaluationRepository,
        evaluator,
        notifier,
        notifications,
        () => new Date(COMPLETED_AT)
      );
      const agentService = new CollectorAgentService(
        new InMemoryCollectorAgentRepository(fixture.report.runId)
      );
      const evidenceStore = new CollectionEvidenceStore(resolve(
        tmpdir(),
        "stau-desktop-report-fixture-evidence"
      ));
      const ingestionService = new DesktopReportIngestionService(
        agentService,
        store,
        evidenceStore,
        reconciler
      );

      const ingestion = await ingestionService.ingest(AGENT_TOKEN, fixture.report);
      const notificationBatch = await notifications.getBatch(fixture.report.runId);
      if (!notificationBatch) {
        throw new Error("Desktop fixture alert reconciliation did not create a notification batch");
      }
      return {
        ingestion,
        report: aggregateCollectionRunReport(store.aggregationInput()),
        alerts: [...alerts.alerts],
        notificationBatch,
        notificationBatchCount: notifications.batches.size,
        sentMessages: [...sender.messages]
      };
    }
  };
}
