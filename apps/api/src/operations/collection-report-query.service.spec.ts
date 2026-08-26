import assert from "node:assert/strict";
import test from "node:test";

import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import {
  COLLECTION_REPORT_MAX_PAGE_SIZE,
  CollectionReportQueryService,
  PrismaCollectionReportRepository,
  type CollectionReportDataRepository,
  type CollectionReportPageRequest,
  type CollectionReportPagedResult,
  type CollectionReportRawIssue,
  type CollectionReportRawPosition,
  type CollectionReportRawRun,
  type CollectionReportRawSnapshot,
  type CollectionRunReportFilters
} from "./collection-report-query.service.ts";

const capturedAt = new Date("2026-08-25T01:30:00.000Z");

function runFixture(overrides: Partial<CollectionReportRawRun> = {}): CollectionReportRawRun {
  return {
    id: "run-7506",
    status: "PARTIAL_FAILED",
    providerKey: "taobao-desktop",
    scheduledFor: capturedAt,
    startedAt: capturedAt,
    finishedAt: new Date("2026-08-25T01:38:00.000Z"),
    searchLimit: 50,
    searchTerminationReason: null,
    ownBaselineSnapshotId: "own-snapshot",
    searchedCount: 47,
    fetchedCount: 47,
    matchedCount: 2,
    failedCount: 3,
    discoveredCount: 47,
    incompleteCount: 3,
    errorCode: "SKU_ENUMERATION_INCOMPLETE",
    errorMessage: "3 个 SKU 未完成采集",
    positionCount: 2,
    uniqueItemCount: 2,
    snapshotCount: 5,
    monitoredModel: {
      id: "model-7506",
      monitorCode: "SONY-7506",
      brand: "Sony",
      standardModel: "MDR-7506",
      comparisonType: "BARE",
      owner: "运营A"
    },
    collectorAgent: {
      id: "agent-mac-1",
      name: "mac-studio-1",
      platform: "MACOS",
      appVersion: "2.4.5"
    },
    alertNotificationBatch: {
      state: "PENDING",
      notificationAttempts: 1,
      notifiedAt: null,
      lastNotificationError: "WECOM_NOT_CONFIGURED"
    },
    ...overrides
  };
}

function positionFixture(rank: number, platformItemId = `item-${rank}`): CollectionReportRawPosition {
  return {
    rank,
    platformItemId,
    url: `https://example.invalid/items/${platformItemId}`,
    shopName: rank === 1 ? "星空乐器专营店" : "同行音频店",
    title: "Sony MDR-7506",
    displayPriceMinFen: 65_800 + rank,
    displayPriceMaxFen: 69_800 + rank,
    sponsored: false,
    capturedAt
  };
}

function snapshotFixture(
  id: string,
  overrides: Partial<CollectionReportRawSnapshot> = {}
): CollectionReportRawSnapshot {
  return {
    id,
    ownListingId: null,
    searchCandidateId: `candidate-${id}`,
    platformItemId: "competitor-7506",
    skuId: id,
    shopName: "同行音频店",
    title: "Sony MDR-7506",
    skuText: "标准版",
    ownListingSkuText: null,
    url: "https://example.invalid/items/competitor-7506",
    listPriceFen: 69_799,
    activityPriceFen: 69_799,
    couponDiscountFen: 0,
    fullReductionFen: 0,
    directDiscountFen: 0,
    mandatoryFeeFen: 0,
    publicDiscountFen: 0,
    payableFen: 69_799,
    priceConfidence: "CONFIRMED",
    stockState: "IN_STOCK",
    matchDecision: "BARE",
    comparable: true,
    matchConfidenceBps: 10_000,
    matchReasons: ["型号一致"],
    evidenceKey: null,
    capturedAt,
    ...overrides
  };
}

function fixtures() {
  const positions = [positionFixture(1, "own-7506"), positionFixture(2, "competitor-7506")];
  const snapshots = [
    snapshotFixture("own-sku", {
      ownListingId: "own-listing-7506",
      searchCandidateId: null,
      platformItemId: "own-7506",
      shopName: "星空乐器专营店",
      ownListingSkuText: "标准版",
      payableFen: 69_800,
      listPriceFen: 69_800,
      activityPriceFen: 69_800,
      evidenceKey: `sha256:${"a".repeat(64)}`
    }),
    snapshotFixture("lower-sku", { evidenceKey: `sha256:${"b".repeat(64)}` }),
    snapshotFixture("review-sku", {
      skuText: "M1",
      title: "Sony MDR-M1",
      payableFen: 40_000,
      priceConfidence: "MANUAL_REVIEW",
      matchDecision: "MANUAL",
      comparable: false,
      matchConfidenceBps: 5_000,
      matchReasons: ["版本不确定"]
    }),
    snapshotFixture("not-lower-sku", { payableFen: 70_000, listPriceFen: 70_000, activityPriceFen: 70_000 }),
    snapshotFixture("excluded-sku", {
      skuText: "二手",
      title: "Sony MDR-7506 二手",
      payableFen: 50_000,
      stockState: "OUT_OF_STOCK",
      matchDecision: "REJECTED",
      comparable: false,
      matchConfidenceBps: 0,
      matchReasons: ["排除二手"]
    })
  ];
  const issues: CollectionReportRawIssue[] = [{
    id: "issue-1",
    code: "SKU_ENUMERATION_INCOMPLETE",
    platformItemId: "competitor-7506",
    skuId: "review-sku",
    message: "SKU 选择不稳定",
    evidenceKey: `sha256:${"c".repeat(64)}`,
    capturedAt
  }];
  return { positions, snapshots, issues };
}

function page<T>(items: T[], request: CollectionReportPageRequest): CollectionReportPagedResult<T> {
  const start = (request.page - 1) * request.pageSize;
  return { items: items.slice(start, start + request.pageSize), total: items.length };
}

function matchCategory(run: CollectionReportRawRun, snapshot: CollectionReportRawSnapshot) {
  if (snapshot.matchDecision === "REJECTED") return "EXCLUDED";
  if (snapshot.comparable && snapshot.matchDecision === run.monitoredModel.comparisonType) return "EXACT";
  return "REVIEW";
}

class FixtureRepository implements CollectionReportDataRepository {
  readonly calls: Array<{ method: string; request?: CollectionReportPageRequest; filters?: CollectionRunReportFilters }> = [];
  readonly runs: CollectionReportRawRun[];
  readonly positions: CollectionReportRawPosition[];
  readonly snapshots: CollectionReportRawSnapshot[];
  readonly issues: CollectionReportRawIssue[];

  constructor(
    runs: CollectionReportRawRun[],
    positions: CollectionReportRawPosition[],
    snapshots: CollectionReportRawSnapshot[],
    issues: CollectionReportRawIssue[]
  ) {
    this.runs = runs;
    this.positions = positions;
    this.snapshots = snapshots;
    this.issues = issues;
  }

  async listRuns(request: CollectionReportPageRequest) {
    this.calls.push({ method: "listRuns", request });
    return page(this.runs, request);
  }

  async findRun(runId: string) {
    this.calls.push({ method: "findRun" });
    return this.runs.find((run) => run.id === runId) ?? null;
  }

  async listPositions(_runId: string, request: CollectionReportPageRequest) {
    this.calls.push({ method: "listPositions", request });
    return page(this.positions, request);
  }

  async listIssues(_runId: string, request: CollectionReportPageRequest) {
    this.calls.push({ method: "listIssues", request });
    return page(this.issues, request);
  }

  async findExactOwnBaseline(_run: CollectionReportRawRun) {
    this.calls.push({ method: "findExactOwnBaseline" });
    const matches = this.snapshots.filter((snapshot) => snapshot.ownListingId
      && snapshot.skuText?.trim().toLowerCase() === snapshot.ownListingSkuText?.trim().toLowerCase()
      && matchCategory(this.runs[0]!, snapshot) === "EXACT"
      && snapshot.stockState === "IN_STOCK"
      && snapshot.priceConfidence === "CONFIRMED"
      && snapshot.payableFen !== null);
    return matches.length === 1 ? matches[0]! : null;
  }

  async listSnapshots(
    run: CollectionReportRawRun,
    filters: CollectionRunReportFilters,
    baseline: CollectionReportRawSnapshot | null,
    request: CollectionReportPageRequest
  ) {
    this.calls.push({ method: "listSnapshots", request, filters });
    const filtered = this.snapshots.filter((snapshot) => {
      const source = snapshot.ownListingId ? "OWN" : "COMPETITOR";
      const category = matchCategory(run, snapshot);
      const comparison = snapshot.ownListingId
        ? "OWN"
        : !baseline || category !== "EXACT" || snapshot.stockState !== "IN_STOCK"
          || snapshot.priceConfidence !== "CONFIRMED" || snapshot.payableFen === null
          ? "UNDECIDED"
          : snapshot.payableFen < baseline.payableFen! ? "LOWER" : "NOT_LOWER";
      return (!filters.source || filters.source === source)
        && (!filters.match || filters.match === category)
        && (!filters.price || filters.price === comparison)
        && (!filters.confidence || filters.confidence === snapshot.priceConfidence);
    });
    return page(filtered, request);
  }

  async listRanks(_runId: string, platformItemIds: string[]) {
    this.calls.push({ method: "listRanks" });
    const accepted = new Set(platformItemIds);
    const ranks = new Map<string, number[]>();
    for (const position of this.positions) {
      if (!accepted.has(position.platformItemId)) continue;
      const current = ranks.get(position.platformItemId) ?? [];
      current.push(position.rank);
      ranks.set(position.platformItemId, current);
    }
    return [...ranks].map(([platformItemId, values]) => ({
      platformItemId,
      ranks: values.sort((left, right) => left - right)
    }));
  }

  async isEvidenceReferenced(runId: string, evidenceKey: string) {
    return this.runs.some((run) => run.id === runId)
      && [...this.snapshots, ...this.issues].some((record) => record.evidenceKey === evidenceKey);
  }
}

function repository() {
  const data = fixtures();
  return new FixtureRepository([runFixture()], data.positions, data.snapshots, data.issues);
}

test("lists collection runs with bounded pagination and aggregate completion facts", async () => {
  const allRuns = Array.from({ length: 235 }, (_, index) => runFixture({
    id: `run-${String(index + 1).padStart(3, "0")}`,
    positionCount: 47,
    uniqueItemCount: 46,
    snapshotCount: 120
  }));
  const data = fixtures();
  const repo = new FixtureRepository(allRuns, data.positions, data.snapshots, data.issues);
  const service = new CollectionReportQueryService(repo);

  const result = await service.listRuns({ page: 2, pageSize: 1000 });

  assert.equal(result.runs.length, 100);
  assert.equal(result.runs[0]?.id, "run-101");
  assert.deepEqual(result.pagination, {
    page: 2,
    pageSize: COLLECTION_REPORT_MAX_PAGE_SIZE,
    total: 235,
    totalPages: 3,
    hasPrevious: true,
    hasNext: true
  });
  assert.equal(result.runs[0]?.completion.positionsCaptured, 47);
  assert.equal(result.runs[0]?.completion.uniqueItemCount, 46);
  assert.equal(result.runs[0]?.completion.skuCount, 120);
  assert.deepEqual(repo.calls.map((call) => call.method), ["listRuns"]);
});

test("does not present legacy aggregate progress as captured rank evidence", async () => {
  const repo = repository();
  repo.runs[0] = runFixture({ searchedCount: 50, incompleteCount: 0, positionCount: 0, uniqueItemCount: 0 });
  const result = await new CollectionReportQueryService(repo).listRuns();

  assert.equal(result.runs[0]?.completion.positionsCaptured, 0);
  assert.equal(result.runs[0]?.completion.complete, false);
  assert.equal(result.runs[0]?.completion.label, "0 / 50，未完成");
});

test("presents a verified early page end as complete but leaves an interrupted short search incomplete", async () => {
  const repo = repository();
  repo.runs[0] = runFixture({
    status: "SUCCEEDED",
    searchLimit: 50,
    searchTerminationReason: "END_MARKER",
    positionCount: 2,
    incompleteCount: 0
  });
  let result = await new CollectionReportQueryService(repo).listRuns();
  assert.deepEqual(result.runs[0]?.completion, {
    positionsCaptured: 2,
    requestedPositions: 50,
    discoveredCount: 47,
    fetchedCount: 47,
    matchedCount: 2,
    failedCount: 3,
    uniqueItemCount: 2,
    skuCount: 5,
    incompleteCount: 0,
    terminationReason: "END_MARKER",
    complete: true,
    label: "2 项，已验证到底"
  });

  repo.runs[0] = runFixture({
    status: "PARTIAL_FAILED",
    searchLimit: 50,
    searchTerminationReason: null,
    positionCount: 2,
    incompleteCount: 1
  });
  result = await new CollectionReportQueryService(repo).listRuns();
  assert.equal(result.runs[0]?.completion.complete, false);
  assert.equal(result.runs[0]?.completion.terminationReason, null);
});

test("bounds every detail collection and reports independent totals", async () => {
  const run = runFixture({ searchLimit: 400, positionCount: 260, uniqueItemCount: 250, snapshotCount: 351 });
  const positions = Array.from({ length: 260 }, (_, index) => positionFixture(index + 1));
  const baseline = fixtures().snapshots[0]!;
  const snapshots = [baseline, ...Array.from({ length: 350 }, (_, index) => snapshotFixture(`sku-${index + 1}`, {
    platformItemId: `item-${(index % 250) + 1}`
  }))];
  const issues = Array.from({ length: 240 }, (_, index) => ({
    id: `issue-${index + 1}`,
    code: "SKU_ENUMERATION_INCOMPLETE",
    platformItemId: `item-${index + 1}`,
    skuId: null,
    message: "fixture issue",
    evidenceKey: null,
    capturedAt
  } satisfies CollectionReportRawIssue));
  const repo = new FixtureRepository([run], positions, snapshots, issues);
  const service = new CollectionReportQueryService(repo);

  const result = await service.getRun(run.id, {}, {
    positionPage: 2,
    positionPageSize: 1_000,
    issuePage: 2,
    issuePageSize: 1_000,
    skuPage: 2,
    skuPageSize: 1_000
  });

  assert.ok(result);
  assert.equal(result.positions.length, 100);
  assert.equal(result.issues.length, 100);
  assert.equal(result.skus.length, 100);
  assert.equal(result.totalSkuCount, 351);
  assert.equal(result.pagination.positions.total, 260);
  assert.equal(result.pagination.issues.total, 240);
  assert.equal(result.pagination.skus.total, 351);
  assert.equal(result.completion.label, "260 / 400，未完成");
  for (const call of repo.calls.filter((entry) => entry.request)) {
    assert.ok(call.request!.pageSize <= COLLECTION_REPORT_MAX_PAGE_SIZE);
  }
});

test("pushes SKU filters into the repository and paginates the filtered result accurately", async () => {
  const repo = repository();
  const service = new CollectionReportQueryService(repo);
  const filters: CollectionRunReportFilters = {
    source: "COMPETITOR",
    match: "EXACT",
    price: "LOWER",
    confidence: "CONFIRMED"
  };

  const result = await service.getRun("run-7506", filters, { skuPage: 1, skuPageSize: 1 });

  assert.ok(result);
  assert.deepEqual(result.skus.map((row) => row.id), ["lower-sku"]);
  assert.equal(result.pagination.skus.total, 1);
  assert.equal(result.totalSkuCount, 5);
  assert.deepEqual(repo.calls.find((call) => call.method === "listSnapshots")?.filters, filters);
  assert.equal(result.skus[0]?.comparison.state, "LOWER");
  assert.equal(result.skus[0]?.comparison.differenceFen, 1);
  assert.equal(result.skus[0]?.evidenceSha256, "b".repeat(64));
});

test("supports exact, review, excluded and not-lower database filter pages", async () => {
  const service = new CollectionReportQueryService(repository());

  assert.deepEqual((await service.getRun("run-7506", { source: "OWN", match: "EXACT" }))?.skus.map((row) => row.id), ["own-sku"]);
  assert.deepEqual((await service.getRun("run-7506", { match: "REVIEW" }))?.skus.map((row) => row.id), ["review-sku"]);
  assert.deepEqual((await service.getRun("run-7506", { match: "EXCLUDED" }))?.skus.map((row) => row.id), ["excluded-sku"]);
  assert.deepEqual((await service.getRun("run-7506", { price: "NOT_LOWER" }))?.skus.map((row) => row.id), ["not-lower-sku"]);
});

test("Prisma list summaries select aggregates and clamp parent cardinality without child includes", async () => {
  let findManyArgs: Record<string, unknown> | undefined;
  const fakePrisma = {
    collectionRun: {
      findMany: async (args: Record<string, unknown>) => { findManyArgs = args; return []; },
      count: async () => 235
    }
  } as unknown as PrismaClient;
  const repository = new PrismaCollectionReportRepository(fakePrisma);

  const result = await repository.listRuns({ page: 2, pageSize: 10_000 });

  assert.equal(result.total, 235);
  assert.equal(findManyArgs?.take, COLLECTION_REPORT_MAX_PAGE_SIZE);
  assert.equal(findManyArgs?.skip, COLLECTION_REPORT_MAX_PAGE_SIZE);
  assert.equal("include" in (findManyArgs ?? {}), false);
  const select = findManyArgs?.select as Record<string, unknown>;
  assert.ok(select._count);
  assert.equal(select.positions, undefined);
  assert.equal(select.snapshots, undefined);
  assert.equal(select.issues, undefined);
});

test("checks an evidence hash against the run before storage access", async () => {
  const service = new CollectionReportQueryService(repository());

  assert.equal(await service.isEvidenceReferenced("run-7506", "b".repeat(64)), true);
  assert.equal(await service.isEvidenceReferenced("run-7506", "d".repeat(64)), false);
  assert.equal(await service.isEvidenceReferenced("other-run", "b".repeat(64)), false);
});
