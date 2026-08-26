import assert from "node:assert/strict";
import test from "node:test";

import type { CollectorReport } from "../../../../packages/contracts/src/index.ts";
import type { CollectorAgentService } from "../collector-agent/collector-agent.service.ts";
import type { CollectionEvidenceStore } from "./collection-evidence-store.ts";
import {
  DesktopReportConflictError,
  DesktopReportIngestionError,
  DesktopReportIngestionService,
  DesktopReportValidationError,
  desktopReportDigest,
  type ClaimedDesktopRun,
  type DesktopReportRepository,
  type IngestionSummary
} from "./desktop-report-ingestion.service.ts";

const evidenceKey = `sha256:${"a".repeat(64)}`;

function reportFixture(): CollectorReport {
  return {
    schemaVersion: 1,
    runId: "run-1",
    collectorId: "agent-1",
    appVersion: "2.4.5",
    startedAt: "2026-08-24T01:30:00.000Z",
    completedAt: "2026-08-24T01:31:00.000Z",
    status: "SUCCEEDED",
    searchLimit: 2,
    positions: [
      {
        rank: 1,
        platformItemId: "1001",
        url: "https://item.taobao.com/item.htm?id=1001",
        shopName: "Own Shop",
        title: "Own listing",
        displayPriceMinFen: 1_000,
        displayPriceMaxFen: 1_000,
        sponsored: false,
        capturedAt: "2026-08-24T01:30:05.000Z"
      },
      {
        rank: 2,
        platformItemId: "2002",
        url: "https://detail.tmall.com/item.htm?id=2002",
        shopName: "Competitor Shop",
        title: "Competitor listing",
        displayPriceMinFen: 1_100,
        displayPriceMaxFen: 1_100,
        sponsored: false,
        capturedAt: "2026-08-24T01:30:06.000Z"
      }
    ],
    ownItems: [{
      ownListingId: "own-1",
      platformItemId: "1001",
      url: "https://item.taobao.com/item.htm?id=1001",
      shopName: "Own Shop",
      title: "Own listing",
      searchRanks: [1],
      skus: [{
        skuId: "own-black",
        label: "Black",
        attributes: { color: "Black" },
        stockState: "IN_STOCK",
        listPriceFen: 1_200,
        activityPriceFen: 1_000,
        couponDiscountFen: 100,
        fullReductionFen: 0,
        directDiscountFen: 0,
        promotions: [{
          kind: "COUPON",
          label: "Public coupon",
          amountFen: 100,
          thresholdFen: 1_000,
          audience: "PUBLIC",
          stackGroup: "shop-coupon",
          includedInActivityPrice: false,
          activityPriceInclusion: "EXCLUDED"
        }],
        mandatoryFeeFen: 0,
        priceConfidence: "CONFIRMED",
        payableFen: 900,
        capturedAt: "2026-08-24T01:30:20.000Z",
        evidenceKey
      }]
    }],
    competitorItems: [{
      platformItemId: "2002",
      url: "https://detail.tmall.com/item.htm?id=2002",
      shopName: "Competitor Shop",
      title: "Competitor listing",
      searchRanks: [2],
      skus: [{
        skuId: "competitor-black",
        label: "Black",
        attributes: { color: "Black" },
        stockState: "IN_STOCK",
        listPriceFen: 1_300,
        activityPriceFen: 1_100,
        couponDiscountFen: 0,
        fullReductionFen: 0,
        directDiscountFen: 0,
        promotions: [],
        mandatoryFeeFen: 0,
        priceConfidence: "CONFIRMED",
        payableFen: 1_100,
        capturedAt: "2026-08-24T01:30:30.000Z",
        evidenceKey: null
      }]
    }],
    issues: []
  };
}

function runFixture(overrides: Partial<ClaimedDesktopRun> = {}): ClaimedDesktopRun {
  return {
    runId: "run-1",
    agentId: "agent-1",
    monitoredModelId: "model-1",
    providerKey: "taobao-desktop",
    searchLimit: 2,
    status: "RUNNING",
    ownListingIds: ["own-1"],
    ...overrides
  };
}

const summary: IngestionSummary = {
  runId: "run-1",
  status: "SUCCEEDED",
  positionCount: 2,
  uniqueItemCount: 2,
  skuCount: 2,
  issueCount: 0,
  ownSnapshotIds: ["own-snapshot-1"],
  competitorSnapshotIds: ["competitor-snapshot-1"]
};

class FakeIdentityService {
  invalidToken = false;
  wrongOwner = false;

  async assertRunOwnership(_token: string, runId: string) {
    if (this.invalidToken) throw new Error("authentication is handled by the real agent service");
    if (this.wrongOwner) throw new Error("ownership is handled by the real agent service");
    return { agentId: "agent-1", runId };
  }
}

class FakeRepository implements DesktopReportRepository {
  run: ClaimedDesktopRun | null = runFixture();
  persisted: CollectorReport[] = [];
  failure: unknown;
  systemErrors: Array<{ agentId: string; runId: string; code: string; message: string }> = [];

  async inspectRun(_agentId: string, _runId: string) {
    return this.run;
  }

  async withEvidenceRunLock<T>(
    _agentId: string,
    _runId: string,
    operation: (mode: "CREATE_OR_REPLAY" | "REPLAY_ONLY") => Promise<T>
  ): Promise<T> {
    if (!this.run || this.run.status === "QUEUED" || this.run.status === "PAUSED_LOGIN"
      || this.run.status === "PAUSED_CHALLENGE" || this.run.status === "COALESCED") {
      throw new DesktopReportConflictError();
    }
    return operation(this.run.status === "RUNNING" ? "CREATE_OR_REPLAY" : "REPLAY_ONLY");
  }

  async ingest(_agentId: string, report: CollectorReport, verifyEvidence: () => Promise<void>) {
    if (this.failure) throw this.failure;
    await verifyEvidence();
    this.persisted.push(report);
    return {
      summary: { ...summary, status: report.status as IngestionSummary["status"] },
      newlyAccepted: true
    };
  }

  async recordSystemError(agentId: string, runId: string, code: string, message: string) {
    this.systemErrors.push({ agentId, runId, code, message });
  }
}

class FakeEvidenceStore {
  available = new Set([evidenceKey]);

  async has(_runId: string, key: string) {
    return this.available.has(key);
  }
}

function createService() {
  const identity = new FakeIdentityService();
  const repository = new FakeRepository();
  const evidence = new FakeEvidenceStore();
  const service = new DesktopReportIngestionService(
    identity as unknown as CollectorAgentService,
    repository,
    evidence as unknown as CollectionEvidenceStore
  );
  return { service, identity, repository, evidence };
}

test("canonical report digests order distinct Unicode object keys deterministically", () => {
  const first = reportFixture();
  first.ownItems[0]!.skus[0]!.attributes = {
    "é": "composed",
    "e\u0301": "decomposed"
  };
  const reordered = structuredClone(first);
  reordered.ownItems[0]!.skus[0]!.attributes = {
    "e\u0301": "decomposed",
    "é": "composed"
  };

  assert.equal(desktopReportDigest(first), desktopReportDigest(reordered));
});

test("accepts the exact terminal shapes emitted by the collector runner", async () => {
  const succeeded = reportFixture();

  const partial = reportFixture();
  partial.status = "PARTIAL_FAILED";
  partial.issues.push({
    code: "PRICE_UNSTABLE",
    message: "Selected-SKU price did not stabilize",
    platformItemId: "2002",
    skuId: "competitor-black",
    capturedAt: partial.completedAt
  });

  const failed = reportFixture();
  failed.status = "FAILED";
  failed.positions = [];
  failed.ownItems = [];
  failed.competitorItems = [];
  failed.issues.push({
    code: "APP_VERSION_UNSUPPORTED",
    message: "Unsupported desktop app version",
    capturedAt: failed.completedAt
  });

  for (const report of [succeeded, partial, failed]) {
    const { service } = createService();
    assert.equal((await service.ingest("pmc_token", report)).status, report.status);
  }
});

test("accepts every runner fatal code only with failed no-progress data", async () => {
  for (const code of [
    "MISSING_ITEM_ID",
    "TAOBAO_NOT_INSTALLED",
    "TAOBAO_NOT_RUNNING",
    "ACCESSIBILITY_PERMISSION_REQUIRED",
    "APP_VERSION_UNSUPPORTED",
    "UI_CONTRACT_CHANGED",
    "SCREEN_RECORDING_PERMISSION_REQUIRED"
  ] as const) {
    const { service } = createService();
    const report = reportFixture();
    report.status = "FAILED";
    report.positions = [];
    report.ownItems = [];
    report.competitorItems = [];
    report.issues = [{ code, message: "Fatal collector failure", capturedAt: report.completedAt }];

    assert.equal((await service.ingest("pmc_token", report)).status, "FAILED", code);
  }
});

test("accepts every runner completion issue only with partial progress", async () => {
  for (const code of [
    "ITEM_UNAVAILABLE",
    "SKU_ENUMERATION_INCOMPLETE",
    "SKU_SELECTION_MISMATCH",
    "PRICE_UNSTABLE",
    "UI_CONTRACT_CHANGED",
    "MISSING_ITEM_ID"
  ] as const) {
    const { service } = createService();
    const report = reportFixture();
    report.status = "PARTIAL_FAILED";
    report.issues = [{
      code,
      message: "Collector stopped after durable progress",
      platformItemId: "2002",
      capturedAt: report.completedAt
    }];

    assert.equal((await service.ingest("pmc_token", report)).status, "PARTIAL_FAILED", code);
  }
});

test("rejects success-shaped reports relabeled as a failure status", async () => {
  for (const status of ["PARTIAL_FAILED", "FAILED"] as const) {
    const { service, repository } = createService();
    const report = reportFixture();
    report.status = status;

    await assert.rejects(
      () => service.ingest("pmc_token", report),
      (error) => error instanceof DesktopReportValidationError,
      status
    );
    assert.equal(repository.persisted.length, 0);
  }
});

test("binds collector identity, claimed own listings, run state, and the claimed rank limit", async () => {
  const cases: Array<{
    name: string;
    mutateReport?: (report: CollectorReport) => void;
    mutateRun?: (run: ClaimedDesktopRun) => void;
  }> = [
    { name: "collector", mutateReport: (report) => { report.collectorId = "agent-other"; } },
    { name: "own listing", mutateReport: (report) => { report.ownItems[0]!.ownListingId = "own-other"; } },
    { name: "rank limit", mutateRun: (run) => { run.searchLimit = 1; } },
    { name: "running state", mutateRun: (run) => { run.status = "PAUSED_LOGIN"; } }
  ];

  for (const entry of cases) {
    const { service, repository } = createService();
    const report = reportFixture();
    entry.mutateReport?.(report);
    entry.mutateRun?.(repository.run!);

    await assert.rejects(
      () => service.ingest("pmc_token", report),
      (error) => error instanceof DesktopReportConflictError,
      entry.name
    );
    assert.equal(repository.persisted.length, 0);
  }
});

test("requires successful reports to account for every claimed own listing exactly once", async () => {
  const cases: Array<{ name: string; mutate: (report: CollectorReport) => void }> = [
    {
      name: "missing own listing",
      mutate: (report) => { report.ownItems = []; }
    },
    {
      name: "unknown own listing",
      mutate: (report) => { report.ownItems[0]!.ownListingId = "own-unknown"; }
    },
    {
      name: "duplicate own listing",
      mutate: (report) => {
        report.ownItems.push({
          ...structuredClone(report.ownItems[0]!),
          platformItemId: "1002",
          url: "https://item.taobao.com/item.htm?id=1002",
          searchRanks: [],
          skus: [{
            ...structuredClone(report.ownItems[0]!.skus[0]!),
            skuId: "own-white"
          }]
        });
      }
    }
  ];

  for (const entry of cases) {
    const { service, repository } = createService();
    const report = reportFixture();
    entry.mutate(report);

    await assert.rejects(
      () => service.ingest("pmc_token", report),
      (error) => error instanceof DesktopReportConflictError
        || error instanceof DesktopReportValidationError,
      entry.name
    );
    assert.equal(repository.persisted.length, 0);
  }
});

test("rejects successful ingestion when either side of the own-listing binding is empty", async () => {
  {
    const { service, repository } = createService();
    repository.run = runFixture({ ownListingIds: [] });

    await assert.rejects(
      () => service.ingest("pmc_token", reportFixture()),
      (error) => error instanceof DesktopReportConflictError
    );
    assert.equal(repository.persisted.length, 0);
  }

  {
    const { service, repository } = createService();
    const report = reportFixture();
    report.ownItems = [];

    await assert.rejects(
      () => service.ingest("pmc_token", report),
      (error) => error instanceof DesktopReportConflictError
        || error instanceof DesktopReportValidationError
    );
    assert.equal(repository.persisted.length, 0);
  }

  {
    const { service, repository } = createService();
    repository.run = runFixture({ ownListingIds: [] });
    const report = reportFixture();
    report.ownItems = [];

    await assert.rejects(
      () => service.ingest("pmc_token", report),
      (error) => error instanceof DesktopReportConflictError
        || error instanceof DesktopReportValidationError
    );
    assert.equal(repository.persisted.length, 0);
  }
});

test("preserves explicit non-success reports when no own listing was collectable", async () => {
  {
    const { service, repository } = createService();
    repository.run = runFixture({ ownListingIds: [] });
    const report = reportFixture();
    report.status = "PARTIAL_FAILED";
    report.ownItems = [];
    report.issues = [{
      code: "UI_CONTRACT_CHANGED",
      message: "Own listing collection stopped after search progress",
      capturedAt: report.completedAt
    }];

    assert.equal((await service.ingest("pmc_token", report)).status, "PARTIAL_FAILED");
  }

  {
    const { service, repository } = createService();
    repository.run = runFixture({ ownListingIds: [] });
    const report = reportFixture();
    report.status = "FAILED";
    report.positions = [];
    report.ownItems = [];
    report.competitorItems = [];
    report.issues = [{
      code: "APP_VERSION_UNSUPPORTED",
      message: "Collector could not start",
      capturedAt: report.completedAt
    }];

    assert.equal((await service.ingest("pmc_token", report)).status, "FAILED");
  }
});

test("rejects URL identity disagreement, reversed completion time, and incomplete success", async () => {
  const cases: Array<{ name: string; mutate: (report: CollectorReport) => void }> = [
    {
      name: "URL identity",
      mutate: (report) => { report.competitorItems[0]!.url = "https://detail.tmall.com/item.htm?id=9999"; }
    },
    {
      name: "completion time",
      mutate: (report) => { report.completedAt = "2026-08-24T01:29:59.000Z"; }
    },
    {
      name: "incomplete success",
      mutate: (report) => {
        report.issues.push({
          code: "SKU_ENUMERATION_INCOMPLETE",
          message: "Enumeration stopped",
          platformItemId: "2002",
          capturedAt: "2026-08-24T01:30:40.000Z"
        });
      }
    }
  ];

  for (const entry of cases) {
    const { service, repository } = createService();
    const report = reportFixture();
    entry.mutate(report);

    await assert.rejects(
      () => service.ingest("pmc_token", report),
      (error) => error instanceof DesktopReportValidationError,
      entry.name
    );
    assert.equal(repository.persisted.length, 0);
  }
});

test("rejects every non-success collector issue on a successful report", async () => {
  for (const code of [
    "MISSING_ITEM_ID",
    "ITEM_UNAVAILABLE",
    "SKU_ENUMERATION_INCOMPLETE",
    "SKU_SELECTION_MISMATCH",
    "PRICE_UNSTABLE",
    "LOGIN_REQUIRED",
    "PLATFORM_CHALLENGE",
    "TAOBAO_NOT_INSTALLED",
    "TAOBAO_NOT_RUNNING",
    "ACCESSIBILITY_PERMISSION_REQUIRED",
    "APP_VERSION_UNSUPPORTED",
    "UI_CONTRACT_CHANGED",
    "SCREEN_RECORDING_PERMISSION_REQUIRED",
    "OWN_BASELINE_MISSING",
    "OWN_BASELINE_AMBIGUOUS"
  ] as const) {
    const { service, repository } = createService();
    const report = reportFixture();
    report.issues.push({
      code,
      message: "Collection was not complete",
      platformItemId: "2002",
      capturedAt: "2026-08-24T01:30:40.000Z"
    });

    await assert.rejects(
      () => service.ingest("pmc_token", report),
      (error) => error instanceof DesktopReportValidationError,
      code
    );
    assert.equal(repository.persisted.length, 0);
  }
});

test("requires partial and failed reports to match runner progress semantics", async () => {
  const cases: Array<{ name: string; mutate: (report: CollectorReport) => void }> = [
    {
      name: "partial without progress",
      mutate: (report) => {
        report.status = "PARTIAL_FAILED";
        report.positions = [];
        report.ownItems = [];
        report.competitorItems = [];
        report.issues = [{
          code: "UI_CONTRACT_CHANGED",
          message: "UI contract changed",
          capturedAt: report.completedAt
        }];
      }
    },
    {
      name: "failed after durable progress",
      mutate: (report) => {
        report.status = "FAILED";
        report.issues = [{
          code: "MISSING_ITEM_ID",
          message: "Stable item identity was unavailable",
          capturedAt: report.completedAt
        }];
      }
    },
    {
      name: "failed with only a recoverable item issue",
      mutate: (report) => {
        report.status = "FAILED";
        report.positions = [];
        report.ownItems = [];
        report.competitorItems = [];
        report.issues = [{
          code: "ITEM_UNAVAILABLE",
          message: "Item unavailable",
          capturedAt: report.completedAt
        }];
      }
    },
    {
      name: "partial with startup-only app version failure",
      mutate: (report) => {
        report.status = "PARTIAL_FAILED";
        report.issues = [{
          code: "APP_VERSION_UNSUPPORTED",
          message: "Unsupported desktop app version",
          capturedAt: report.completedAt
        }];
      }
    },
    {
      name: "partial with startup-only screen recording failure",
      mutate: (report) => {
        report.status = "PARTIAL_FAILED";
        report.issues = [{
          code: "SCREEN_RECORDING_PERMISSION_REQUIRED",
          message: "Screen recording permission required",
          capturedAt: report.completedAt
        }];
      }
    },
    {
      name: "partial with a competitor item but no search progress",
      mutate: (report) => {
        report.status = "PARTIAL_FAILED";
        report.positions = [];
        report.ownItems = [];
        report.competitorItems[0]!.searchRanks = [];
        report.competitorItems = [report.competitorItems[0]!];
        report.issues = [{
          code: "PRICE_UNSTABLE",
          message: "Price did not stabilize",
          platformItemId: "2002",
          capturedAt: report.completedAt
        }];
      }
    }
  ];

  for (const entry of cases) {
    const { service, repository } = createService();
    const report = reportFixture();
    entry.mutate(report);

    await assert.rejects(
      () => service.ingest("pmc_token", report),
      (error) => error instanceof DesktopReportValidationError,
      entry.name
    );
    assert.equal(repository.persisted.length, 0);
  }
});

test("requires pause reports to use the pause endpoint", async () => {
  for (const status of ["PAUSED_LOGIN", "PAUSED_CHALLENGE"] as const) {
    const { service, repository } = createService();
    const report = reportFixture();
    report.status = status;

    await assert.rejects(
      () => service.ingest("pmc_token", report),
      (error) => error instanceof DesktopReportValidationError
    );
    assert.equal(repository.persisted.length, 0);
  }
});

test("requires every report evidence key to exist beneath the same run", async () => {
  const { service, repository, evidence } = createService();
  evidence.available.clear();

  await assert.rejects(
    () => service.ingest("pmc_token", reportFixture()),
    (error) => error instanceof DesktopReportValidationError
  );
  assert.equal(repository.persisted.length, 0);
});

test("records only a sanitized retryable system error when transactional persistence fails", async () => {
  const { service, repository } = createService();
  const unsafe = "account-title /private/operator/evidence.png";
  repository.failure = new Error(unsafe);

  const error = await service.ingest("pmc_token", reportFixture()).then(
    () => null,
    (caught: unknown) => caught
  );

  assert.ok(error instanceof DesktopReportIngestionError);
  assert.equal(String(error).includes(unsafe), false);
  assert.equal(String(error.stack).includes(unsafe), false);
  assert.deepEqual(repository.systemErrors, [{
    agentId: "agent-1",
    runId: "run-1",
    code: "DESKTOP_REPORT_INGESTION_FAILED",
    message: "Desktop report ingestion failed"
  }]);
});

test("commits ingestion before reconciliation and preserves its terminal receipt when reconciliation fails", async () => {
  const identity = new FakeIdentityService();
  const repository = new FakeRepository();
  const evidence = new FakeEvidenceStore();
  const events: string[] = [];
  const originalIngest = repository.ingest.bind(repository);
  repository.ingest = async (...arguments_) => {
    events.push("ingestion-started");
    const result = await originalIngest(...arguments_);
    events.push("ingestion-committed");
    return result;
  };
  const reconciler = {
    async reconcileRun(runId: string) {
      assert.equal(runId, "run-1");
      assert.deepEqual(events, ["ingestion-started", "ingestion-committed"]);
      events.push("reconciliation-attempted");
      throw new Error("webhook key and request body must stay private");
    }
  };
  const service = new DesktopReportIngestionService(
    identity as unknown as CollectorAgentService,
    repository,
    evidence as unknown as CollectionEvidenceStore,
    reconciler
  );

  const result = await service.ingest("pmc_token", reportFixture());

  assert.equal(result.status, "SUCCEEDED");
  assert.deepEqual(events, [
    "ingestion-started",
    "ingestion-committed",
    "reconciliation-attempted"
  ]);
  assert.equal(repository.persisted.length, 1);
  assert.deepEqual(repository.systemErrors, []);
});
