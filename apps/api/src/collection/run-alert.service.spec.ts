import assert from "node:assert/strict";
import test from "node:test";

import type {
  AlertRepository,
  PriceAlertRecord
} from "../alerts/alert.service.ts";
import {
  RunAlertService,
  type CandidateMatchPersistence,
  type RunAlertData,
  type RunAlertRepository,
  type RunAlertUnitOfWork,
  type SnapshotMatchPersistence
} from "./run-alert.service.ts";

function snapshot(input: Partial<RunAlertData["snapshots"][number]> & {
  id: string;
  platformItemId: string;
  skuId: string;
  skuText: string;
  payableFen: number;
}): RunAlertData["snapshots"][number] {
  return {
    id: input.id,
    ownListingId: input.ownListingId ?? null,
    ownListingSkuText: input.ownListingSkuText ?? null,
    searchCandidateId: input.searchCandidateId ?? null,
    platformItemId: input.platformItemId,
    skuId: input.skuId,
    shopName: input.shopName ?? "同行店铺",
    title: input.title ?? "索尼 MDR-7506 专业监听耳机",
    skuText: input.skuText,
    attributes: input.attributes ?? { 型号: input.skuText },
    bundleComponents: input.bundleComponents ?? null,
    listPriceFen: input.listPriceFen ?? input.payableFen,
    activityPriceFen: input.activityPriceFen ?? input.payableFen ?? 0,
    publicDiscountFen: input.publicDiscountFen ?? 0,
    payableFen: input.payableFen,
    priceConfidence: input.priceConfidence ?? "CONFIRMED",
    stockState: input.stockState ?? "IN_STOCK",
    capturedAt: input.capturedAt ?? new Date("2026-08-25T01:30:05.000Z"),
    url: input.url ?? `https://item.taobao.com/item.htm?id=${input.platformItemId}`,
    searchRanks: input.searchRanks ?? [1]
  };
}

function bareRun(): RunAlertData {
  const own = snapshot({
    id: "own-snapshot",
    ownListingId: "own-listing",
    ownListingSkuText: "MDR-7506 单机",
    platformItemId: "own-item",
    skuId: "own-7506",
    shopName: "星空乐器专营店",
    skuText: "MDR-7506 单机",
    payableFen: 69_800,
    capturedAt: new Date("2026-08-25T01:30:00.000Z"),
    searchRanks: []
  });
  const competitor = (
    id: string,
    payableFen: number,
    extra: Partial<RunAlertData["snapshots"][number]> = {}
  ) => snapshot({
    ...extra,
    id: `snapshot-${id}`,
    searchCandidateId: `candidate-${id}`,
    platformItemId: `item-${id}`,
    skuId: `sku-${id}`,
    skuText: extra.skuText ?? "MDR-7506 单机",
    payableFen: extra.payableFen ?? payableFen,
    searchRanks: extra.searchRanks ?? [Number(id.replace(/\D/g, "")) || 1]
  });

  return {
    runId: "run-bare",
    status: "SUCCEEDED",
    searchLimit: 6,
    positionCount: 6,
    skuCount: 7,
    issueCount: 0,
    completedAt: new Date("2026-08-25T01:31:00.000Z"),
    model: {
      id: "model-7506",
      brand: "Sony",
      standardModel: "MDR-7506",
      version: null,
      comparisonType: "BARE",
      owner: "张三",
      effectiveAliases: ["索尼 7506", "7506"],
      excludedAliases: [],
      mustIncludeTerms: [],
      excludedTerms: ["M1", "MV1", "展示样机", "单独转换线"],
      bundleItems: []
    },
    snapshots: [
      own,
      competitor("1", 69_800, { searchRanks: [1] }),
      competitor("2", 69_799, { searchRanks: [2] }),
      competitor("3", 65_800, { searchRanks: [3] }),
      competitor("4", 60_000, { priceConfidence: "MANUAL_REVIEW", searchRanks: [4] }),
      competitor("5", 50_000, { stockState: "OUT_OF_STOCK", searchRanks: [5] }),
      competitor("6", 40_000, {
        skuText: "M1",
        attributes: { 型号: "M1" },
        searchRanks: [6]
      })
    ]
  };
}

class FakeAlertRepository implements AlertRepository {
  alerts: PriceAlertRecord[] = [];

  async createIfAbsent(input: Omit<PriceAlertRecord, "id" | "notifiedAt">) {
    if (this.alerts.some((alert) => alert.dedupKey === input.dedupKey)) return null;
    const alert: PriceAlertRecord = {
      ...input,
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
  readonly issues = new Set<"OWN_BASELINE_MISSING" | "OWN_BASELINE_AMBIGUOUS">();
  ownBaselineSnapshotId: string | null = null;
  data: RunAlertData;

  constructor(data: RunAlertData) {
    this.data = data;
  }

  async withEvaluation<T>(
    runId: string,
    operation: (unit: RunAlertUnitOfWork) => Promise<T>
  ): Promise<T> {
    assert.equal(runId, this.data.runId);
    return operation(this);
  }

  async saveSnapshotDecisions(decisions: SnapshotMatchPersistence[]) {
    for (const decision of decisions) this.snapshotDecisions.set(decision.snapshotId, decision);
  }

  async saveCandidateDecisions(decisions: CandidateMatchPersistence[]) {
    for (const decision of decisions) this.candidateDecisions.set(decision.candidateId, decision);
  }

  async saveOwnBaselineSnapshot(snapshotId: string | null) {
    this.ownBaselineSnapshotId = snapshotId;
  }

  async ensureBaselineIssue(code: "OWN_BASELINE_MISSING" | "OWN_BASELINE_AMBIGUOUS") {
    const created = !this.issues.has(code);
    this.issues.add(code);
    return created;
  }
}

function context(data = bareRun()) {
  const repository = new FakeRunAlertRepository(data);
  const service = new RunAlertService(
    repository,
    (runId) => `https://monitor.example.test/collection-runs/${runId}`
  );
  return { repository, service };
}

interface BundleComponentFixture {
  accessoryType: string;
  brand: string | null;
  modelOrName: string;
  quantity: number;
}

function withBundleComponents(
  value: RunAlertData["snapshots"][number],
  components: BundleComponentFixture[]
): RunAlertData["snapshots"][number] {
  Reflect.set(value, "bundleComponents", components);
  return value;
}

test("creates confirmed lows only for the exact in-stock confirmed 69799 and 65800 fen SKUs", async () => {
  const { repository, service } = context();

  const summary = await service.evaluateRun("run-bare");

  assert.deepEqual(
    summary.alerts.map((alert) => [alert.severity, alert.payableFen]),
    [["CONFIRMED_LOW", 69_799], ["CONFIRMED_LOW", 65_800]]
  );
  assert.equal(summary.baseline?.payableFen, 69_800);
  assert.equal(summary.checkedItemCount, 6);
  assert.equal(summary.searchLimit, 6);
  assert.equal(summary.systemIssue, null);
  assert.equal(repository.alerts.alerts.length, 2);
  assert.equal(repository.ownBaselineSnapshotId, "own-snapshot");

  assert.equal(repository.snapshotDecisions.size, 7);
  assert.equal(repository.snapshotDecisions.get("snapshot-2")?.decision, "BARE");
  assert.equal(repository.snapshotDecisions.get("snapshot-6")?.decision, "REJECTED");
  assert.equal(repository.snapshotDecisions.get("snapshot-6")?.comparable, false);
});

test("persists an attribute-only punctuation-normalized own baseline for report comparison", async () => {
  const data = bareRun();
  data.snapshots[0]!.ownListingSkuText = "MDR-7506 / 单机";
  data.snapshots[0]!.skuText = "请选择规格";
  data.snapshots[0]!.attributes = { 型号配置: "MDR 7506 单机" };
  const { repository, service } = context(data);

  const result = await service.evaluateRun(data.runId);

  assert.equal(result.baseline?.snapshotId, "own-snapshot");
  assert.equal(repository.ownBaselineSnapshotId, "own-snapshot");
});

test("derives one candidate decision from all of its SKU snapshots", async () => {
  const data = bareRun();
  data.snapshots = [
    data.snapshots[0]!,
    snapshot({
      id: "candidate-mixed-wrong",
      searchCandidateId: "candidate-mixed",
      platformItemId: "item-mixed",
      skuId: "mixed-m1",
      skuText: "M1",
      payableFen: 40_000
    }),
    snapshot({
      id: "candidate-mixed-exact",
      searchCandidateId: "candidate-mixed",
      platformItemId: "item-mixed",
      skuId: "mixed-7506",
      skuText: "MDR-7506 单机",
      payableFen: 68_000
    }),
    snapshot({
      id: "candidate-review",
      searchCandidateId: "candidate-review",
      platformItemId: "item-review",
      skuId: "review-cable",
      skuText: "MDR-7506 + C口转换线",
      payableFen: 60_000
    }),
    snapshot({
      id: "candidate-rejected",
      searchCandidateId: "candidate-rejected",
      platformItemId: "item-rejected",
      skuId: "rejected-mv1",
      skuText: "MV1",
      payableFen: 30_000
    })
  ];
  const { repository, service } = context(data);

  await service.evaluateRun(data.runId);

  assert.deepEqual(repository.candidateDecisions.get("candidate-mixed"), {
    candidateId: "candidate-mixed",
    decision: "BARE",
    comparable: true,
    confidenceBps: 9300,
    normalizedModel: "MDR-7506",
    reasons: repository.snapshotDecisions.get("candidate-mixed-exact")!.reasons
  });
  assert.equal(repository.candidateDecisions.get("candidate-review")?.decision, "MANUAL");
  assert.equal(repository.candidateDecisions.get("candidate-review")?.comparable, false);
  assert.equal(repository.candidateDecisions.get("candidate-rejected")?.decision, "REJECTED");
});

for (const fixture of [
  {
    name: "missing",
    code: "OWN_BASELINE_MISSING" as const,
    mutate(data: RunAlertData) {
      data.snapshots[0]!.skuText = "MDR-7506 展示样机";
      data.snapshots[0]!.attributes = { 型号: "展示样机" };
    }
  },
  {
    name: "ambiguous",
    code: "OWN_BASELINE_AMBIGUOUS" as const,
    mutate(data: RunAlertData) {
      data.snapshots.push({
        ...structuredClone(data.snapshots[0]!),
        id: "own-snapshot-duplicate",
        skuId: "own-7506-duplicate"
      });
    }
  }
]) {
  test(`persists one ${fixture.name} own-baseline issue and makes no competitor conclusion`, async () => {
    const data = bareRun();
    fixture.mutate(data);
    const { repository, service } = context(data);

    const first = await service.evaluateRun(data.runId);
    const repeated = await service.evaluateRun(data.runId);

    assert.equal(first.systemIssue, fixture.code);
    assert.equal(first.baseline, null);
    assert.deepEqual(first.alerts, []);
    assert.equal(repeated.systemIssue, fixture.code);
    assert.equal(repository.issues.size, 1);
    assert.equal(repository.alerts.alerts.length, 0);
    assert.equal(repository.ownBaselineSnapshotId, null);
  });
}

test("compares an exact bundle signature and makes a different signature manual review only", async () => {
  const data = bareRun();
  data.runId = "run-bundle";
  data.model.comparisonType = "BUNDLE";
  data.model.bundleItems = [
    {
      accessoryType: "耳机",
      brand: "Sony",
      modelOrName: "MDR-7506",
      quantity: 1,
      core: true
    },
    {
      accessoryType: "转换线",
      brand: null,
      modelOrName: "C口转换线",
      quantity: 1,
      core: true
    }
  ];
  const exactComponents: BundleComponentFixture[] = [
    { accessoryType: "耳机", brand: "Sony", modelOrName: "MDR-7506", quantity: 1 },
    { accessoryType: "转换线", brand: null, modelOrName: "C口转换线", quantity: 1 }
  ];
  data.snapshots = [
    withBundleComponents(snapshot({
      id: "own-bundle",
      ownListingId: "own-listing",
      ownListingSkuText: "MDR-7506 + C口转换线套装",
      platformItemId: "own-item",
      skuId: "own-bundle-sku",
      shopName: "星空乐器专营店",
      skuText: "MDR-7506 + C口转换线套装",
      attributes: { 耳机: "MDR-7506", 配件: "C口转换线", 数量: "1" },
      payableFen: 75_000,
      searchRanks: []
    }), exactComponents),
    withBundleComponents(snapshot({
      id: "exact-bundle",
      searchCandidateId: "candidate-exact-bundle",
      platformItemId: "item-exact-bundle",
      skuId: "exact-bundle-sku",
      skuText: "C口转换线 + MDR-7506 套装",
      attributes: { 耳机: "MDR-7506", 配件: "C口转换线", 数量: "1" },
      payableFen: 74_999,
      searchRanks: [1]
    }), exactComponents),
    withBundleComponents(snapshot({
      id: "different-bundle",
      searchCandidateId: "candidate-different-bundle",
      platformItemId: "item-different-bundle",
      skuId: "different-bundle-sku",
      skuText: "MDR-7506 + Lightning转换线套装",
      attributes: { 耳机: "MDR-7506", 配件: "Lightning转换线", 数量: "1" },
      payableFen: 70_000,
      searchRanks: [2]
    }), [
      exactComponents[0]!,
      { accessoryType: "转换线", brand: null, modelOrName: "Lightning转换线", quantity: 1 }
    ]),
    withBundleComponents(snapshot({
      id: "expanded-bundle",
      searchCandidateId: "candidate-expanded-bundle",
      platformItemId: "item-expanded-bundle",
      skuId: "expanded-bundle-sku",
      skuText: "MDR-7506 + C口转换线 + 耳机包套装",
      attributes: { 耳机: "MDR-7506", 配件: "C口转换线", 加赠: "耳机包", 数量: "1" },
      payableFen: 69_000,
      searchRanks: [3]
    }), [
      ...exactComponents,
      { accessoryType: "收纳", brand: null, modelOrName: "防尘收纳盒", quantity: 1 }
    ]),
    withBundleComponents(snapshot({
      id: "quantity-x2-bundle",
      searchCandidateId: "candidate-quantity-x2-bundle",
      platformItemId: "item-quantity-x2-bundle",
      skuId: "quantity-x2-bundle-sku",
      skuText: "MDR-7506 + C口转换线 x2 套装",
      attributes: { 耳机: "MDR-7506", 配件: "C口转换线 x2" },
      payableFen: 68_000,
      searchRanks: [4]
    }), [
      exactComponents[0]!,
      { ...exactComponents[1]!, quantity: 2 }
    ]),
    withBundleComponents(snapshot({
      id: "quantity-two-cables-bundle",
      searchCandidateId: "candidate-quantity-two-cables-bundle",
      platformItemId: "item-quantity-two-cables-bundle",
      skuId: "quantity-two-cables-bundle-sku",
      skuText: "MDR-7506 + C口转换线2条 套装",
      attributes: { 耳机: "MDR-7506", 配件: "C口转换线2条" },
      payableFen: 67_000,
      searchRanks: [5]
    }), [
      exactComponents[0]!,
      { ...exactComponents[1]!, quantity: 2 }
    ]),
    withBundleComponents(snapshot({
      id: "missing-required-bundle",
      searchCandidateId: "candidate-missing-required-bundle",
      platformItemId: "item-missing-required-bundle",
      skuId: "missing-required-bundle-sku",
      skuText: "MDR-7506 套装",
      attributes: { 耳机: "MDR-7506" },
      payableFen: 66_000,
      searchRanks: [6]
    }), [exactComponents[0]!]),
    snapshot({
      id: "unstructured-bundle",
      searchCandidateId: "candidate-unstructured-bundle",
      platformItemId: "item-unstructured-bundle",
      skuId: "unstructured-bundle-sku",
      skuText: "MDR-7506 + C口转换线套装",
      attributes: { 耳机: "MDR-7506", 配件: "C口转换线", 数量: "1" },
      payableFen: 65_000,
      searchRanks: [7]
    })
  ];
  data.searchLimit = 7;
  data.positionCount = 7;
  const { repository, service } = context(data);

  const summary = await service.evaluateRun(data.runId);

  assert.deepEqual(
    summary.alerts.map((alert) => [alert.severity, alert.snapshotId]),
    [
      ["CONFIRMED_LOW", "exact-bundle"],
      ["MANUAL_REVIEW", "different-bundle"],
      ["MANUAL_REVIEW", "expanded-bundle"],
      ["MANUAL_REVIEW", "quantity-x2-bundle"],
      ["MANUAL_REVIEW", "quantity-two-cables-bundle"],
      ["MANUAL_REVIEW", "missing-required-bundle"],
      ["MANUAL_REVIEW", "unstructured-bundle"]
    ]
  );
  assert.equal(repository.snapshotDecisions.get("exact-bundle")?.decision, "BUNDLE");
  assert.equal(repository.snapshotDecisions.get("exact-bundle")?.comparable, true);
  assert.equal(repository.snapshotDecisions.get("different-bundle")?.decision, "MANUAL");
  assert.equal(repository.snapshotDecisions.get("different-bundle")?.comparable, false);
  assert.equal(repository.snapshotDecisions.get("expanded-bundle")?.decision, "MANUAL");
  assert.equal(repository.snapshotDecisions.get("expanded-bundle")?.comparable, false);
  for (const id of [
    "quantity-x2-bundle",
    "quantity-two-cables-bundle",
    "missing-required-bundle",
    "unstructured-bundle"
  ]) {
    assert.equal(repository.snapshotDecisions.get(id)?.decision, "MANUAL");
    assert.equal(repository.snapshotDecisions.get(id)?.comparable, false);
  }
});
