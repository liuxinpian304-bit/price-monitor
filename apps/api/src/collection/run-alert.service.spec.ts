import assert from "node:assert/strict";
import test from "node:test";

import type { AlertRepository, PriceAlertRecord } from "../alerts/alert.service.ts";
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
} from "./run-alert.service.ts";

interface ComponentFixture {
  role: "CORE" | "PAID_ACCESSORY" | "GIFT_OR_SERVICE" | "UNKNOWN";
  accessoryType: string;
  brand: string | null;
  modelOrName: string;
  quantity: number;
}

const core: ComponentFixture = {
  role: "CORE",
  accessoryType: "耳机",
  brand: "Sony",
  modelOrName: "MDR-7506",
  quantity: 1
};
const cable: ComponentFixture = {
  role: "PAID_ACCESSORY",
  accessoryType: "转换线",
  brand: null,
  modelOrName: "C口转换线",
  quantity: 1
};
const stand: ComponentFixture = {
  role: "PAID_ACCESSORY",
  accessoryType: "耳机架",
  brand: null,
  modelOrName: "HPS-1",
  quantity: 1
};

function snapshot(input: {
  id: string;
  platformItemId: string;
  skuId: string;
  payableFen: number | null;
  ownListingId?: string | null;
  searchCandidateId?: string | null;
  shopName?: string;
  title?: string;
  skuText?: string;
  attributes?: Record<string, string>;
  components?: ComponentFixture[] | null;
  priceConfidence?: "CONFIRMED" | "ESTIMATED" | "MANUAL_REVIEW";
  stockState?: "IN_STOCK" | "OUT_OF_STOCK" | "UNKNOWN";
  searchRanks?: number[];
}): RunAlertData["snapshots"][number] {
  const displayPrice = input.payableFen ?? 0;
  return {
    id: input.id,
    ownListingId: input.ownListingId ?? null,
    ownListingSkuText: input.ownListingId ? "MDR-7506 单机" : null,
    searchCandidateId: input.searchCandidateId ?? null,
    platformItemId: input.platformItemId,
    skuId: input.skuId,
    shopName: input.shopName ?? "同行店铺",
    title: input.title ?? "Sony MDR-7506 专业监听耳机",
    skuText: input.skuText ?? "MDR-7506 单机",
    attributes: input.attributes ?? { 型号: "MDR-7506" },
    components: input.components === undefined ? [{ ...core }] : input.components,
    listPriceFen: displayPrice,
    activityPriceFen: displayPrice,
    publicDiscountFen: 0,
    payableFen: input.payableFen,
    priceConfidence: input.priceConfidence ?? "CONFIRMED",
    stockState: input.stockState ?? "IN_STOCK",
    capturedAt: new Date("2026-08-25T01:30:05.000Z"),
    url: `https://item.taobao.com/item.htm?id=${input.platformItemId}`,
    searchRanks: input.searchRanks ?? []
  } as RunAlertData["snapshots"][number];
}

function runData(snapshots: RunAlertData["snapshots"]): RunAlertData {
  return {
    runId: "run-fixture",
    status: "SUCCEEDED",
    searchLimit: 50,
    positionCount: snapshots.filter((item) => item.searchCandidateId !== null).length,
    skuCount: snapshots.length,
    issueCount: 0,
    completedAt: new Date("2026-08-25T01:31:00.000Z"),
    claimedOwnListingIds: snapshots.flatMap((item) => item.ownListingId ? [item.ownListingId] : []),
    ownCatalogComplete: true,
    model: {
      id: "model-7506",
      brand: "Sony",
      standardModel: "MDR-7506",
      version: null,
      comparisonType: "BARE",
      colorComparable: false,
      owner: "张三",
      effectiveAliases: ["索尼 7506", "7506"],
      excludedAliases: [],
      mustIncludeTerms: [],
      excludedTerms: ["M1", "MV1", "展示样机", "单独转换线"],
      bundleItems: []
    },
    snapshots
  } as RunAlertData;
}

class FakeAlertRepository implements AlertRepository {
  readonly alerts: PriceAlertRecord[] = [];

  async createIfAbsent(input: Omit<PriceAlertRecord, "id" | "notifiedAt">) {
    if (this.alerts.some((alert) => alert.dedupKey === input.dedupKey)) return null;
    const alert: PriceAlertRecord = {
      ...input,
      reasons: [...input.reasons],
      id: `alert-${this.alerts.length + 1}`,
      notifiedAt: null
    };
    this.alerts.push(alert);
    return alert;
  }

  async markBatchNotified(ids: string[], notifiedAt: Date) {
    for (const alert of this.alerts.filter((item) => ids.includes(item.id))) {
      alert.notifiedAt = notifiedAt;
    }
  }

  async recordBatchNotificationFailure(_ids: string[], _message: string) {}
}

class FakeRunAlertRepository implements RunAlertRepository, RunAlertUnitOfWork {
  readonly alerts = new FakeAlertRepository();
  readonly snapshotDecisions = new Map<string, SnapshotMatchPersistence>();
  readonly candidateDecisions = new Map<string, CandidateMatchPersistence>();
  readonly combinationDecisions = new Map<string, SnapshotCombinationPersistence>();
  readonly issues = new Set<BaselineIssueCode>();
  readonly notificationBatches: RunAlertSummary[] = [];
  ownBaselineSnapshotId: string | null = null;
  readonly data: RunAlertData;

  constructor(data: RunAlertData) {
    this.data = data;
  }

  get savedCombinationDecisions(): SnapshotCombinationPersistence[] {
    return [...this.combinationDecisions.values()];
  }

  async withEvaluation<T>(runId: string, operation: (unit: RunAlertUnitOfWork) => Promise<T>) {
    assert.equal(runId, this.data.runId);
    return operation(this);
  }

  async saveSnapshotDecisions(decisions: SnapshotMatchPersistence[]) {
    for (const decision of decisions) {
      this.snapshotDecisions.set(decision.snapshotId, { ...decision, reasons: [...decision.reasons] });
    }
  }

  async saveCandidateDecisions(decisions: CandidateMatchPersistence[]) {
    for (const decision of decisions) {
      this.candidateDecisions.set(decision.candidateId, { ...decision, reasons: [...decision.reasons] });
    }
  }

  async saveCombinationDecisions(decisions: SnapshotCombinationPersistence[]) {
    for (const decision of decisions) {
      this.combinationDecisions.set(decision.snapshotId, {
        ...decision,
        reasons: { ...decision.reasons, codes: [...decision.reasons.codes] }
      });
    }
  }

  async saveOwnBaselineSnapshot(snapshotId: string | null) {
    this.ownBaselineSnapshotId = snapshotId;
  }

  async ensureBaselineIssue(code: BaselineIssueCode) {
    const created = !this.issues.has(code);
    this.issues.add(code);
    return created;
  }

  async ensureNotificationBatch(summary: RunAlertSummary) {
    if (!this.notificationBatches.some((batch) => batch.runId === summary.runId)) {
      this.notificationBatches.push(structuredClone(summary));
    }
  }
}

function context(data: RunAlertData) {
  const repository = new FakeRunAlertRepository(data);
  const service = new RunAlertService(
    repository,
    (runId) => `https://monitor.example.test/collection-runs/${runId}`
  );
  return { repository, service };
}

test("evaluates every exact combination with its own baseline and groups missing combinations", async () => {
  const data = runData([
    snapshot({ id: "own-single", ownListingId: "listing-single", platformItemId: "own-single-item", skuId: "own-single-sku", payableFen: 69_800 }),
    snapshot({ id: "own-bundle", ownListingId: "listing-bundle", platformItemId: "own-bundle-item", skuId: "own-bundle-sku", payableFen: 75_000, components: [core, cable] }),
    snapshot({ id: "competitor-single-low", searchCandidateId: "candidate-single", platformItemId: "competitor-single-item", skuId: "competitor-single-sku", shopName: "同行甲店", payableFen: 69_799, searchRanks: [2] }),
    snapshot({ id: "competitor-bundle-equal", searchCandidateId: "candidate-bundle", platformItemId: "competitor-bundle-item", skuId: "competitor-bundle-sku", shopName: "同行乙店", payableFen: 75_000, components: [core, cable], searchRanks: [4] }),
    snapshot({ id: "competitor-missing", searchCandidateId: "candidate-missing", platformItemId: "competitor-missing-item", skuId: "competitor-missing-sku", shopName: "同行丙店", payableFen: 65_000, components: [core, stand], searchRanks: [3, 8] })
  ]);
  data.runId = "run-multi-baseline";
  const { repository, service } = context(data);

  const summary = await service.evaluateRun(data.runId);

  assert.deepEqual(repository.savedCombinationDecisions.map((item) => [item.snapshotId, item.state]), [
    ["own-single", "OWN"],
    ["own-bundle", "OWN"],
    ["competitor-single-low", "MATCHED"],
    ["competitor-bundle-equal", "MATCHED"],
    ["competitor-missing", "MISSING_OWN"]
  ]);
  assert.equal(summary.alerts.length, 1);
  assert.equal(summary.alerts[0]?.ownSnapshotId, "own-single");
  assert.equal(summary.alerts[0]?.ownPayableFen, 69_800);
  assert.equal(summary.alerts[0]?.payableFen, 69_799);
  assert.equal(summary.alerts[0]?.differenceFen, 1);
  assert.equal(summary.alerts[0]?.combinationSignature.startsWith("sku-combination-v1:"), true);
  assert.equal(summary.missingOwnGroups.length, 1);
  assert.equal(summary.missingOwnGroups[0]?.earliestRank, 3);
  assert.equal(summary.missingOwnGroups[0]?.representativeUrl.includes("competitor-missing-item"), true);
  assert.equal(summary.positionCount, 3);
  assert.equal(summary.shopCount, 3);
  assert.equal(summary.reviewCount, 0);
  assert.equal(summary.systemIssue, null);
  assert.equal(repository.issues.size, 0);
  assert.equal(repository.alerts.alerts.length, 1);
  assert.equal(repository.ownBaselineSnapshotId, "own-single");
  assert.equal(repository.notificationBatches.length, 1);
  assert.equal(repository.snapshotDecisions.size, 5);
  assert.equal(repository.candidateDecisions.size, 3);
});

test("selects deterministic lowest own links without creating an ambiguous-baseline issue", async () => {
  const data = runData([
    snapshot({ id: "own-z", ownListingId: "listing-z", platformItemId: "own-z-item", skuId: "own-z-sku", payableFen: 69_800 }),
    snapshot({ id: "own-a", ownListingId: "listing-a", platformItemId: "own-a-item", skuId: "own-a-sku", payableFen: 69_800 }),
    snapshot({ id: "competitor", searchCandidateId: "candidate", platformItemId: "competitor-item", skuId: "competitor-sku", payableFen: 69_799, searchRanks: [1] })
  ]);
  data.runId = "run-deterministic-own-links";
  const { repository, service } = context(data);

  const summary = await service.evaluateRun(data.runId);

  assert.equal(summary.alerts[0]?.ownSnapshotId, "own-a");
  assert.equal(repository.ownBaselineSnapshotId, "own-a");
  assert.equal(summary.systemIssue, null);
  assert.equal(repository.issues.has("OWN_BASELINE_AMBIGUOUS"), false);
});

test("downgrades absent own combinations to review when the claimed catalog is incomplete", async () => {
  const data = runData([
    snapshot({ id: "own-single", ownListingId: "listing-single", platformItemId: "own-single-item", skuId: "own-single-sku", payableFen: 69_800 }),
    snapshot({ id: "competitor-unknown-own", searchCandidateId: "candidate-unknown-own", platformItemId: "competitor-unknown-own-item", skuId: "competitor-unknown-own-sku", payableFen: 65_000, components: [core, stand], searchRanks: [1] })
  ]);
  data.runId = "run-incomplete-own-catalog";
  data.claimedOwnListingIds = ["listing-single", "listing-not-collected"];
  data.ownCatalogComplete = false;
  const { repository, service } = context(data);

  const summary = await service.evaluateRun(data.runId);

  assert.equal(repository.combinationDecisions.get("competitor-unknown-own")?.state, "REVIEW");
  assert.deepEqual(repository.combinationDecisions.get("competitor-unknown-own")?.reasons.codes, ["OWN_CATALOG_INCOMPLETE"]);
  assert.equal(summary.reviewCount, 1);
  assert.deepEqual(summary.missingOwnGroups, []);
  assert.deepEqual(summary.alerts, []);
  assert.equal(summary.systemIssue, null);
  assert.equal(repository.issues.size, 0);
  assert.equal(repository.notificationBatches.length, 1);
});

test("creates OWN_BASELINE_MISSING only when no claimed own listing produced a snapshot", async () => {
  const data = runData([
    snapshot({ id: "competitor-only", searchCandidateId: "candidate-only", platformItemId: "competitor-only-item", skuId: "competitor-only-sku", payableFen: 65_000, searchRanks: [1] })
  ]);
  data.runId = "run-no-claimed-own-snapshot";
  data.claimedOwnListingIds = ["listing-not-collected"];
  data.ownCatalogComplete = false;
  const { repository, service } = context(data);

  const first = await service.evaluateRun(data.runId);
  const repeated = await service.evaluateRun(data.runId);

  assert.equal(first.systemIssue, "OWN_BASELINE_MISSING");
  assert.equal(first.issueCount, 1);
  assert.deepEqual(first.alerts, []);
  assert.equal(repeated.systemIssue, "OWN_BASELINE_MISSING");
  assert.equal(repository.issues.size, 1);
  assert.equal(repository.alerts.alerts.length, 0);
  assert.equal(repository.ownBaselineSnapshotId, null);
  assert.equal(repository.notificationBatches.length, 1);
});

test("does not alert or create issues for equal, higher, missing, review, or excluded rows", async () => {
  const data = runData([
    snapshot({ id: "own", ownListingId: "listing-own", platformItemId: "own-item", skuId: "own-sku", payableFen: 69_800 }),
    snapshot({ id: "equal", searchCandidateId: "candidate-equal", platformItemId: "equal-item", skuId: "equal-sku", payableFen: 69_800, searchRanks: [1] }),
    snapshot({ id: "higher", searchCandidateId: "candidate-higher", platformItemId: "higher-item", skuId: "higher-sku", payableFen: 69_801, searchRanks: [2] }),
    snapshot({ id: "missing", searchCandidateId: "candidate-missing", platformItemId: "missing-item", skuId: "missing-sku", payableFen: 60_000, components: [core, stand], searchRanks: [3] }),
    snapshot({ id: "review", searchCandidateId: "candidate-review", platformItemId: "review-item", skuId: "review-sku", payableFen: null, priceConfidence: "MANUAL_REVIEW", searchRanks: [4] }),
    snapshot({ id: "product-review", searchCandidateId: "candidate-product-review", platformItemId: "product-review-item", skuId: "product-review-sku", skuText: "MDR-7506 + C口转换线套装", payableFen: 55_000, components: [core, cable], searchRanks: [5] }),
    snapshot({ id: "excluded", searchCandidateId: "candidate-excluded", platformItemId: "excluded-item", skuId: "excluded-sku", title: "Sony MDR-7506 展示机", payableFen: 50_000, searchRanks: [6] })
  ]);
  data.runId = "run-no-alert-terminal-states";
  const { repository, service } = context(data);

  const summary = await service.evaluateRun(data.runId);

  assert.deepEqual(summary.alerts, []);
  assert.equal(repository.alerts.alerts.length, 0);
  assert.equal(repository.issues.size, 0);
  assert.deepEqual(["equal", "higher", "missing", "review", "product-review", "excluded"].map((id) => [
    id,
    repository.combinationDecisions.get(id)?.state
  ]), [
    ["equal", "MATCHED"],
    ["higher", "MATCHED"],
    ["missing", "MISSING_OWN"],
    ["review", "REVIEW"],
    ["product-review", "REVIEW"],
    ["excluded", "EXCLUDED"]
  ]);
  assert.equal(repository.notificationBatches.length, 1);
});

test("persists exactly one zero-alert notification batch across repeated evaluation", async () => {
  const data = runData([
    snapshot({ id: "own", ownListingId: "listing-own", platformItemId: "own-item", skuId: "own-sku", payableFen: 69_800 }),
    snapshot({ id: "equal", searchCandidateId: "candidate-equal", platformItemId: "equal-item", skuId: "equal-sku", payableFen: 69_800, searchRanks: [1] })
  ]);
  data.runId = "run-zero-alert-batch";
  const { repository, service } = context(data);

  const first = await service.evaluateRun(data.runId);
  const repeated = await service.evaluateRun(data.runId);

  assert.deepEqual(first.alerts, []);
  assert.deepEqual(repeated.alerts, []);
  assert.equal(repository.notificationBatches.length, 1);
});
