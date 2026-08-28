import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { collectorReportSchema, type CollectorJob } from "@stau-price-monitor/contracts";

import { AtomicCheckpointStore, type CollectorCheckpoint } from "./checkpoint-store.ts";
import { assertCheckpointSemanticCoherence, unresolvedSearchIdentity } from "./checkpoint-semantics.ts";
import {
  CollectionInterruptedError,
  CollectionRunner,
  hashCollectorJob
} from "./collection-runner.ts";
import { FixtureDriver } from "../drivers/fixture/fixture-driver.ts";
import {
  DriverIssueError,
  DriverSkuIssueError,
  LoginRequiredError,
  PlatformChallengeError,
  type TaobaoDesktopDriver
} from "./desktop-driver.ts";

const fixturePath = fileURLToPath(new URL("../../test/fixtures/sony-7506.json", import.meta.url));

const job: CollectorJob = {
  schemaVersion: 1,
  runId: "sony-run-1",
  collectorId: "collector-fixture-1",
  monitoredModelId: "sony-mdr-7506",
  searchQuery: "索尼 7506",
  searchLimit: 3,
  ownShopName: "星空乐器专营店",
  ownListings: [{
    id: "own-listing-7506",
    url: "https://detail.example.test/item.htm?id=own-7506",
    skuText: "7506 单机"
  }],
  rule: {
    brand: "Sony",
    standardModel: "MDR-7506",
    version: null,
    comparisonType: "BARE",
    colorComparable: false,
    effectiveAliases: ["7506"],
    excludedAliases: ["M1", "MV1"],
    mustIncludeTerms: ["7506"],
    excludedTerms: ["二手", "样机", "单独线材"]
  }
};

class RecordingCheckpointStore extends AtomicCheckpointStore {
  readonly snapshots: CollectorCheckpoint[] = [];

  override async save(runId: string, state: CollectorCheckpoint): Promise<void> {
    this.snapshots.push(structuredClone(state));
    await super.save(runId, state);
  }
}

interface MutableFixtureResult {
  selection: Record<string, string>;
  availability: "AVAILABLE" | "UNAVAILABLE";
  reason?: string;
  view?: {
    selectedLabels: Record<string, string>;
    activityPriceText: string | null;
    components?: Array<{
      role: "CORE" | "PAID_ACCESSORY" | "GIFT_OR_SERVICE" | "UNKNOWN";
      accessoryType: string;
      brand: string | null;
      modelOrName: string;
      quantity: number;
    }>;
    evidencePath?: string;
  };
}

interface MutableFixtureItem {
  platformItemId: string | null;
  pageSkuCount?: number;
  skuDimensions: Array<{
    name: string;
    options: Array<{ id: string; label: string; enabled: boolean }>;
  }>;
  skuResults: MutableFixtureResult[];
}

interface MutableFixture {
  ownListings: Array<{ item: MutableFixtureItem }>;
  search: {
    positions: Array<{ platformItemId: string | null; url: string }>;
    items: MutableFixtureItem[];
  };
}

const fixtureUnavailableSkuId = "sku_cca30add7d15231188fb6dbd5341169c66f18a53dc721c2e18935778b1cf3c93";
const fixtureBareSkuId = "sku_1ae01c6469db4c89ecca7aff8cd91222c2b4219748c199c77a4caa0e1cd7710a";
const fixtureCableSkuId = "sku_e16888693c1b2e4802d1d639857cea046a8e384fb0c67aaf195b5d64310617ce";

async function writeFixtureCopy(
  root: string,
  mutate: (fixture: MutableFixture) => void
): Promise<string> {
  const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as MutableFixture;
  mutate(fixture);
  const path = join(root, "fixture.json");
  await writeFile(path, `${JSON.stringify(fixture)}\n`, "utf8");
  return path;
}

function withDiagnose(
  driver: FixtureDriver,
  diagnose: TaobaoDesktopDriver["diagnose"]
): TaobaoDesktopDriver {
  return {
    diagnose,
    openOwnListing: (url) => driver.openOwnListing(url),
    search: (query, limit) => driver.search(query, limit),
    openSearchPosition: (position) => driver.openSearchPosition(position),
    selectSku: (selection) => driver.selectSku(selection),
    returnToSearch: () => driver.returnToSearch()
  };
}

function emptyCheckpoint(
  checkpointJob: CollectorJob,
  reportCollectorId = checkpointJob.collectorId
): CollectorCheckpoint {
  const capturedAt = "2026-08-24T05:00:00.000Z";
  return {
    schemaVersion: 1,
    checkpointFormatVersion: 2,
    runId: checkpointJob.runId,
    jobHash: hashCollectorJob(checkpointJob),
    phase: "OWN_LISTINGS",
    completedOwnListingIds: [],
    completedPlatformItemIds: [],
    completedSkuKeys: [],
    report: {
      schemaVersion: 1,
      runId: checkpointJob.runId,
      collectorId: reportCollectorId,
      appVersion: "fixture-1.0",
      startedAt: capturedAt,
      completedAt: capturedAt,
      status: "FAILED",
      searchLimit: checkpointJob.searchLimit,
      positions: [],
      ownItems: [],
      competitorItems: [],
      issues: []
    },
    evidenceManifest: {},
    identityAliases: {}
  };
}

test("collects every enabled Sony SKU while preserving duplicate search ranks", async () => {
  const root = await mkdtemp(join(tmpdir(), "collector-workflow-"));
  try {
    const driver = await FixtureDriver.fromFile(fixturePath);
    const store = new RecordingCheckpointStore(root);
    const report = await new CollectionRunner(driver, store).run(job, job.collectorId);

    assert.equal(report.status, "SUCCEEDED");
    assert.deepEqual(report.positions.map((position) => [position.rank, position.platformItemId]), [
      [1, "competitor-a"],
      [2, "competitor-b"],
      [3, "competitor-a"]
    ]);
    assert.equal(report.ownItems[0]?.shopName, "星空乐器专营店");

    const itemA = report.competitorItems.find((item) => item.platformItemId === "competitor-a");
    assert.ok(itemA);
    assert.deepEqual(itemA.searchRanks, [1, 3]);
    assert.deepEqual(itemA.skus.map((sku) => sku.label), [
      "7506 单机",
      "7506 + C口转换线",
      "M1",
      "MV1"
    ]);
    assert.equal(driver.events.filter((event) =>
      event.type === "OPEN_SEARCH_POSITION" && event.platformItemId === "competitor-a").length, 1);

    const bare = itemA.skus.find((sku) => sku.label === "7506 单机");
    assert.ok(bare);
    assert.equal(bare.activityPriceFen, 65_800);
    assert.equal(bare.couponDiscountFen, 2_000);
    assert.equal(bare.fullReductionFen, 0);
    assert.equal(bare.payableFen, 63_800);

    const cable = itemA.skus.find((sku) => sku.label === "7506 + C口转换线");
    assert.ok(cable);
    assert.equal(cable.activityPriceFen, 72_800);
    assert.equal(cable.payableFen, 70_800);

    const itemB = report.competitorItems.find((item) => item.platformItemId === "competitor-b");
    assert.ok(itemB);
    assert.equal(itemB.skus.length, 1);
    assert.equal(itemB.skus[0]?.stockState, "OUT_OF_STOCK");
    for (const item of [...report.ownItems, ...report.competitorItems]) {
      for (const sku of item.skus) assert.ok(sku.components?.length);
    }

    const checkpoint = await store.load(job.runId);
    assert.equal(checkpoint?.phase, "COMPLETE");
    assert.equal(checkpoint?.completedSkuKeys.length, 6);
    assert.equal(checkpoint?.report.status, "SUCCEEDED");
    for (let completedCount = 1; completedCount <= 6; completedCount += 1) {
      assert.equal(store.snapshots.some((snapshot) =>
        snapshot.completedSkuKeys.length === completedCount), true);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preserves structured bundle components from the desktop driver", async () => {
  const root = await mkdtemp(join(tmpdir(), "collector-bundle-components-"));
  const componentJob = { ...job, runId: "sony-bundle-components-run" };
  try {
    const components = [
      { role: "CORE" as const, accessoryType: "耳机", brand: "Sony", modelOrName: "MDR-7506", quantity: 1 },
      { role: "UNKNOWN" as const, accessoryType: "转换线", brand: null, modelOrName: "C口转换线", quantity: 1 }
    ];
    const path = await writeFixtureCopy(root, (fixture) => {
      const item = fixture.search.items.find((candidate) => candidate.platformItemId === "competitor-a");
      assert.ok(item);
      const cable = item.skuResults.find((result) => result.view?.selectedLabels.型号 === "7506 + C口转换线");
      assert.ok(cable?.view);
      cable.view.components = components;
    });
    const report = await new CollectionRunner(
      await FixtureDriver.fromFile(path),
      new AtomicCheckpointStore(join(root, "checkpoints"))
    ).run(componentJob, componentJob.collectorId);

    const cable = report.competitorItems
      .find((item) => item.platformItemId === "competitor-a")
      ?.skus.find((sku) => sku.label === "7506 + C口转换线");
    assert.deepEqual(cable?.components, components);
    assert.doesNotThrow(() => collectorReportSchema.parse(report));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("graceful interruption stops after saving the current SKU boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "collector-interruption-"));
  try {
    const fixtureDriver = await FixtureDriver.fromFile(fixturePath);
    const controller = new AbortController();
    let selectionCalls = 0;
    const driver: TaobaoDesktopDriver = {
      diagnose: () => fixtureDriver.diagnose(),
      openOwnListing: (url) => fixtureDriver.openOwnListing(url),
      search: (query, limit) => fixtureDriver.search(query, limit),
      openSearchPosition: (position) => fixtureDriver.openSearchPosition(position),
      async selectSku(selection) {
        selectionCalls += 1;
        const result = await fixtureDriver.selectSku(selection);
        controller.abort();
        return result;
      },
      returnToSearch: () => fixtureDriver.returnToSearch()
    };
    const store = new AtomicCheckpointStore(root);

    await assert.rejects(
      () => new CollectionRunner(driver, store).run(job, job.collectorId, controller.signal),
      CollectionInterruptedError
    );

    const checkpoint = await store.load(job.runId);
    assert.ok(checkpoint);
    assert.equal(selectionCalls, 1);
    assert.equal(checkpoint.completedSkuKeys.length, 1);
    assert.equal(checkpoint.phase, "OWN_LISTINGS");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pauses for login and resumes without selecting a completed SKU twice", async () => {
  const root = await mkdtemp(join(tmpdir(), "collector-login-resume-"));
  try {
    const store = new AtomicCheckpointStore(root);
    const pausedDriver = await FixtureDriver.fromFile(fixturePath, {
      pauseAfterCompletedSkuCount: 1,
      pauseType: "LOGIN_REQUIRED"
    });

    const paused = await new CollectionRunner(pausedDriver, store).run(job, job.collectorId);
    assert.equal(paused.status, "PAUSED_LOGIN");
    assert.equal(paused.issues.some((entry) => entry.code === "LOGIN_REQUIRED"), true);
    assert.equal((await store.load(job.runId))?.completedSkuKeys.length, 1);
    assert.equal(pausedDriver.events.filter((event) => event.type === "SELECT_SKU").length, 2);

    const resumedDriver = await FixtureDriver.fromFile(fixturePath);
    const resumed = await new CollectionRunner(resumedDriver, store).run(job, job.collectorId);
    assert.equal(resumed.status, "SUCCEEDED");
    assert.equal(resumedDriver.events.some((event) =>
      event.type === "SELECT_SKU" && event.platformItemId === "own-7506"), false);
    assert.equal((await store.load(job.runId))?.completedSkuKeys.length, 6);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pauses once for a platform challenge without retrying automatically", async () => {
  const root = await mkdtemp(join(tmpdir(), "collector-challenge-"));
  const challengeJob = { ...job, runId: "sony-challenge-run" };
  try {
    const store = new AtomicCheckpointStore(root);
    const driver = await FixtureDriver.fromFile(fixturePath, {
      pauseAfterCompletedSkuCount: 1,
      pauseType: "PLATFORM_CHALLENGE"
    });

    const paused = await new CollectionRunner(driver, store).run(challengeJob, challengeJob.collectorId);
    assert.equal(paused.status, "PAUSED_CHALLENGE");
    assert.equal(paused.issues.some((entry) => entry.code === "PLATFORM_CHALLENGE"), true);
    assert.equal(driver.events.filter((event) => event.type === "SELECT_SKU").length, 2);
    assert.equal((await store.load(challengeJob.runId))?.completedSkuKeys.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses to resume a checkpoint with a different canonical job hash", async () => {
  const root = await mkdtemp(join(tmpdir(), "collector-hash-mismatch-"));
  const hashJob = { ...job, runId: "sony-hash-run" };
  try {
    const store = new AtomicCheckpointStore(root);
    const pausedDriver = await FixtureDriver.fromFile(fixturePath, {
      pauseAfterCompletedSkuCount: 1,
      pauseType: "LOGIN_REQUIRED"
    });
    await new CollectionRunner(pausedDriver, store).run(hashJob, hashJob.collectorId);

    const healthyDriver = await FixtureDriver.fromFile(fixturePath);
    await assert.rejects(
      new CollectionRunner(healthyDriver, store).run({ ...hashJob, searchLimit: 2 }, hashJob.collectorId),
      /job hash mismatch/i
    );
    assert.equal(healthyDriver.events.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("records a dynamic unavailable selection as an explicit incomplete SKU issue", async () => {
  const root = await mkdtemp(join(tmpdir(), "collector-unavailable-"));
  const unavailableJob = { ...job, runId: "sony-unavailable-run" };
  try {
    const path = await writeFixtureCopy(root, (fixture) => {
      const item = fixture.search.items.find((candidate) => candidate.platformItemId === "competitor-b");
      assert.ok(item);
      const selection = item.skuResults[0]?.selection;
      assert.ok(selection);
      item.skuResults = [{ selection, availability: "UNAVAILABLE", reason: "Out of stock" }];
    });
    const store = new AtomicCheckpointStore(join(root, "checkpoints"));
    const report = await new CollectionRunner(await FixtureDriver.fromFile(path), store)
      .run(unavailableJob, unavailableJob.collectorId);

    assert.equal(report.status, "PARTIAL_FAILED");
    const item = report.competitorItems.find((candidate) => candidate.platformItemId === "competitor-b");
    assert.ok(item);
    assert.deepEqual(item.skus, []);
    assert.equal(report.issues.some((entry) => entry.code === "SKU_ENUMERATION_INCOMPLETE"
      && entry.platformItemId === "competitor-b" && entry.skuId === fixtureUnavailableSkuId
      && entry.message.includes("Out of stock")), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not manufacture prices after selection mismatch or unstable price text", async () => {
  const root = await mkdtemp(join(tmpdir(), "collector-invalid-selection-"));
  const invalidJob = { ...job, runId: "sony-invalid-selection-run" };
  try {
    const path = await writeFixtureCopy(root, (fixture) => {
      const item = fixture.search.items.find((candidate) => candidate.platformItemId === "competitor-a");
      assert.ok(item);
      const bare = item.skuResults[0];
      const cable = item.skuResults[1];
      assert.ok(bare?.view);
      assert.ok(cable?.view);
      bare.view.selectedLabels = { 型号: "MV1" };
      cable.view.activityPriceText = null;
    });
    const report = await new CollectionRunner(
      await FixtureDriver.fromFile(path),
      new AtomicCheckpointStore(join(root, "checkpoints"))
    ).run(invalidJob, invalidJob.collectorId);

    assert.equal(report.status, "PARTIAL_FAILED");
    const item = report.competitorItems.find((candidate) => candidate.platformItemId === "competitor-a");
    assert.ok(item);
    assert.deepEqual(item.skus.map((sku) => sku.label), ["M1", "MV1"]);
    assert.equal(report.issues.some((entry) =>
      entry.code === "SKU_SELECTION_MISMATCH" && entry.skuId === fixtureBareSkuId), true);
    assert.equal(report.issues.some((entry) =>
      entry.code === "PRICE_UNSTABLE" && entry.skuId === fixtureCableSkuId), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keeps local evidence paths only in the checkpoint manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "collector-evidence-"));
  const evidenceJob = { ...job, runId: "sony-evidence-run" };
  try {
    const evidencePath = join(root, "selected-sku.png");
    const evidenceBytes = Buffer.from("sanitized fixture PNG bytes");
    await writeFile(evidencePath, evidenceBytes);
    const path = await writeFixtureCopy(root, (fixture) => {
      const view = fixture.ownListings[0]?.item.skuResults[0]?.view;
      assert.ok(view);
      view.evidencePath = evidencePath;
    });
    const store = new AtomicCheckpointStore(join(root, "checkpoints"));
    const report = await new CollectionRunner(await FixtureDriver.fromFile(path), store)
      .run(evidenceJob, evidenceJob.collectorId);

    const evidenceKey = `sha256:${createHash("sha256").update(evidenceBytes).digest("hex")}`;
    assert.equal(report.ownItems[0]?.skus[0]?.evidenceKey, evidenceKey);
    assert.equal(JSON.stringify(report).includes(evidencePath), false);
    assert.equal((await store.load(evidenceJob.runId))?.evidenceManifest[evidenceKey], evidencePath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports MISSING_ITEM_ID instead of completing a detail page without a stable ID", async () => {
  const root = await mkdtemp(join(tmpdir(), "collector-null-item-id-"));
  const fallbackJob = { ...job, runId: "sony-null-item-id-run" };
  try {
    const itemUrl = "https://item.example.test/item.htm?id=competitor-a";
    const path = await writeFixtureCopy(root, (fixture) => {
      for (const position of fixture.search.positions) {
        if (position.url === itemUrl) position.platformItemId = null;
      }
      const item = fixture.search.items.find((candidate) => candidate.platformItemId === "competitor-a");
      assert.ok(item);
      item.platformItemId = null;
    });
    const fixtureDriver = await FixtureDriver.fromFile(path);
    const driver: TaobaoDesktopDriver = {
      diagnose: () => fixtureDriver.diagnose(),
      openOwnListing: (url) => fixtureDriver.openOwnListing(url),
      search: (query, limit) => fixtureDriver.search(query, limit),
      openSearchPosition: (position) => {
        if (position.url === itemUrl) assert.equal(position.platformItemId, null);
        return fixtureDriver.openSearchPosition(position);
      },
      selectSku: (selection) => fixtureDriver.selectSku(selection),
      returnToSearch: () => fixtureDriver.returnToSearch()
    };
    const report = await new CollectionRunner(
      driver,
      new AtomicCheckpointStore(join(root, "checkpoints"))
    ).run(fallbackJob, fallbackJob.collectorId);

    assert.equal(report.status, "PARTIAL_FAILED");
    assert.equal(report.issues.some((issue) => issue.code === "MISSING_ITEM_ID"), true);
    assert.equal(report.positions.some((position) => position.platformItemId.startsWith("unresolved:")), false);
    assert.equal(report.competitorItems.some((item) => item.platformItemId.startsWith("unresolved:")), false);
    assert.equal(fixtureDriver.events.filter((event) =>
      event.type === "OPEN_SEARCH_POSITION" && event.platformItemId === null).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resets search-derived progress coherently when a later rank has no stable item ID", async () => {
  const root = await mkdtemp(join(tmpdir(), "collector-late-missing-item-id-"));
  const missingJob: CollectorJob = {
    ...job,
    runId: "late-missing-item-id-run",
    searchLimit: 2
  };
  const capturedAt = "2026-08-24T09:00:00.000Z";

  function makeDriver(resolveSecond: boolean): TaobaoDesktopDriver & { openedRanks: number[] } {
    let currentRank = 0;
    const openedRanks: number[] = [];
    return {
      openedRanks,
      async diagnose() {
        return {
          appInstalled: true,
          accessibilityTrusted: true,
          screenRecordingTrusted: true,
          appRunning: true,
          processId: 123,
          bundleId: "fixture.taobao.desktop",
          appVersion: "2.4.5",
          appBuild: "15",
          hasFrontWindow: true,
          loginState: "LOGGED_IN",
          rawEvidence: { source: "test", capturedAt, metadata: {} }
        };
      },
      async openOwnListing() {
        currentRank = -1;
        return {
          platformItemId: "own-7506",
          url: "https://detail.example.test/item.htm?id=own-7506",
          shopName: missingJob.ownShopName,
          title: "Sony MDR-7506 own",
          skuDimensions: [],
          pageSkuCount: 1,
          rawEvidence: { source: "test", capturedAt, metadata: {} }
        };
      },
      async search() {
        const positions = [
          { rank: 1, platformItemId: "stable-a", url: "https://item.example.test/item.htm?id=stable-a" },
          { rank: 2, platformItemId: null, url: "https://item.example.test/" }
        ].map((entry) => ({
          ...entry,
          shopName: `示例店${entry.rank}`,
          title: `示例商品${entry.rank}`,
          displayPriceMinText: "100.00",
          displayPriceMaxText: "100.00",
          sponsored: false,
          capturedAt,
          rawEvidence: { source: "test", capturedAt, metadata: { rank: entry.rank } }
        }));
        return { positions, terminationReason: "LIMIT_REACHED" };
      },
      async openSearchPosition(position) {
        currentRank = position.rank;
        openedRanks.push(position.rank);
        const platformItemId = position.rank === 1 ? "stable-a" : resolveSecond ? "stable-b" : null;
        return {
          platformItemId,
          url: platformItemId
            ? `https://item.example.test/item.htm?id=${platformItemId}`
            : "https://item.example.test/",
          shopName: position.shopName,
          title: position.title,
          skuDimensions: [],
          pageSkuCount: 1,
          rawEvidence: { source: "test", capturedAt, metadata: { rank: position.rank } }
        };
      },
      async selectSku() {
        assert.notEqual(currentRank, 0);
        return {
          availability: "AVAILABLE" as const,
          view: {
            selectedLabels: {},
            listPriceText: "100.00",
            activityPriceText: "100.00",
            officialEstimatedPayablePriceText: null,
            promotions: [],
            mandatoryFeeText: "0.00",
            stockState: "IN_STOCK" as const,
            capturedAt,
            rawEvidence: { source: "test", capturedAt, metadata: {} }
          }
        };
      },
      async returnToSearch() { currentRank = 0; }
    };
  }

  try {
    const store = new AtomicCheckpointStore(join(root, "checkpoints"));
    const missingDriver = makeDriver(false);
    const failed = await new CollectionRunner(missingDriver, store)
      .run(missingJob, missingJob.collectorId);
    assert.equal(failed.issues.some((entry) => entry.code === "MISSING_ITEM_ID"), true);

    const checkpoint = await store.load(missingJob.runId);
    assert.ok(checkpoint);
    assert.doesNotThrow(() => assertCheckpointSemanticCoherence(checkpoint, missingJob));

    const resumedDriver = makeDriver(true);
    const resumed = await new CollectionRunner(resumedDriver, store)
      .run(missingJob, missingJob.collectorId);
    assert.equal(resumed.status, "SUCCEEDED");
    assert.deepEqual(resumed.competitorItems.map((item) => item.platformItemId), ["stable-a", "stable-b"]);
    assert.deepEqual(resumedDriver.openedRanks, [1, 2]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("clears own-item search ranks when missing-ID rollback removes every search position", async () => {
  const root = await mkdtemp(join(tmpdir(), "collector-own-rank-rollback-"));
  const rollbackJob: CollectorJob = {
    ...job,
    runId: "own-rank-rollback-run",
    ownListings: [{
      id: "own-ranked-listing",
      url: "https://item.example.test/item.htm?id=own-ranked",
      skuText: "标准款"
    }],
    searchLimit: 2
  };
  const capturedAt = "2026-08-24T10:00:00.000Z";
  let currentItemId: string | null = null;
  const driver: TaobaoDesktopDriver = {
    async diagnose() {
      return {
        appInstalled: true,
        accessibilityTrusted: true,
        screenRecordingTrusted: true,
        appRunning: true,
        processId: 123,
        bundleId: "fixture.taobao.desktop",
        appVersion: "2.4.5",
        appBuild: "15",
        hasFrontWindow: true,
        loginState: "LOGGED_IN",
        rawEvidence: { source: "test", capturedAt, metadata: {} }
      };
    },
    async openOwnListing() {
      currentItemId = "own-ranked";
      return {
        platformItemId: "own-ranked",
        url: "https://item.example.test/item.htm?id=own-ranked",
        shopName: rollbackJob.ownShopName,
        title: "自有商品",
        skuDimensions: [],
        pageSkuCount: 1,
        rawEvidence: { source: "test", capturedAt, metadata: {} }
      };
    },
    async search() {
      const positions = [
        { rank: 1, platformItemId: "own-ranked", url: "https://item.example.test/item.htm?id=own-ranked" },
        { rank: 2, platformItemId: null, url: "https://item.example.test/" }
      ].map((entry) => ({
        ...entry,
        shopName: entry.rank === 1 ? rollbackJob.ownShopName : "示例店",
        title: entry.rank === 1 ? "自有商品" : "无稳定编号商品",
        displayPriceMinText: "100.00",
        displayPriceMaxText: "100.00",
        sponsored: false,
        capturedAt,
        rawEvidence: { source: "test", capturedAt, metadata: { rank: entry.rank } }
      }));
      return { positions, terminationReason: "LIMIT_REACHED" };
    },
    async openSearchPosition(position) {
      assert.equal(position.rank, 2);
      currentItemId = null;
      return {
        platformItemId: null,
        url: "https://item.example.test/",
        shopName: position.shopName,
        title: position.title,
        skuDimensions: [],
        pageSkuCount: 1,
        rawEvidence: { source: "test", capturedAt, metadata: { rank: position.rank } }
      };
    },
    async selectSku() {
      assert.equal(currentItemId, "own-ranked");
      return {
        availability: "AVAILABLE" as const,
        view: {
          selectedLabels: {},
          listPriceText: "100.00",
          activityPriceText: "100.00",
          officialEstimatedPayablePriceText: null,
          promotions: [],
          mandatoryFeeText: "0.00",
          stockState: "IN_STOCK" as const,
          capturedAt,
          rawEvidence: { source: "test", capturedAt, metadata: {} }
        }
      };
    },
    async returnToSearch() { currentItemId = null; }
  };

  try {
    const store = new AtomicCheckpointStore(join(root, "checkpoints"));
    const report = await new CollectionRunner(driver, store)
      .run(rollbackJob, rollbackJob.collectorId);
    assert.equal(report.status, "PARTIAL_FAILED");
    assert.equal(report.issues.some((entry) => entry.code === "MISSING_ITEM_ID"), true);
    assert.deepEqual(report.positions, []);
    assert.deepEqual(report.ownItems[0]?.searchRanks, []);
    assert.doesNotThrow(() => collectorReportSchema.parse(report));

    const checkpoint = await store.load(rollbackJob.runId);
    assert.ok(checkpoint);
    assert.doesNotThrow(() => assertCheckpointSemanticCoherence(checkpoint, rollbackJob));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("upgrades fallback search identities when detail traversal discovers a stable item ID", async () => {
  const root = await mkdtemp(join(tmpdir(), "collector-identity-upgrade-"));
  const upgradeJob = { ...job, runId: "sony-identity-upgrade-run" };
  try {
    const itemUrl = "https://item.example.test/item.htm?id=competitor-a";
    const path = await writeFixtureCopy(root, (fixture) => {
      const matchingPositions = fixture.search.positions.filter((position) => position.url === itemUrl);
      assert.equal(matchingPositions.length, 2);
      matchingPositions[0]!.platformItemId = null;
      matchingPositions[1]!.platformItemId = "competitor-a";
    });
    const driver = await FixtureDriver.fromFile(path);
    const report = await new CollectionRunner(
      driver,
      new AtomicCheckpointStore(join(root, "checkpoints"))
    ).run(upgradeJob, upgradeJob.collectorId);

    assert.equal(report.status, "SUCCEEDED");
    assert.deepEqual(report.positions.filter((position) => position.url === itemUrl)
      .map((position) => position.platformItemId), ["competitor-a", "competitor-a"]);
    assert.deepEqual(report.competitorItems.find((item) =>
      item.platformItemId === "competitor-a")?.searchRanks, [1, 3]);
    assert.equal(driver.events.filter((event) =>
      event.type === "OPEN_SEARCH_POSITION" && event.platformItemId === "competitor-a").length, 1);
    assert.doesNotThrow(() => collectorReportSchema.parse(report));

    const checkpoint = await new AtomicCheckpointStore(join(root, "checkpoints")).load(upgradeJob.runId);
    const fallbackIdentity = unresolvedSearchIdentity(1, itemUrl);
    assert.equal(checkpoint?.completedPlatformItemIds.includes(fallbackIdentity), false);
    assert.equal(checkpoint?.completedPlatformItemIds.includes("competitor-a"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolves same-URL host-only ranks independently across pause and resume", async () => {
  const root = await mkdtemp(join(tmpdir(), "collector-rank-scoped-identities-"));
  const sameUrl = "https://item.example.test/";
  const identityJob: CollectorJob = {
    ...job,
    runId: "rank-scoped-identities-run",
    searchLimit: 2
  };
  const capturedAt = "2026-08-24T08:00:00.000Z";

  function makeDriver(pauseOnSecond: boolean): TaobaoDesktopDriver & { openedRanks: number[] } {
    let currentId: string | null = null;
    let paused = false;
    const openedRanks: number[] = [];
    return {
      openedRanks,
      async diagnose() {
        return {
          appInstalled: true,
          accessibilityTrusted: true,
          screenRecordingTrusted: true,
          appRunning: true,
          processId: 123,
          bundleId: "fixture.taobao.desktop",
          appVersion: "2.4.5",
          appBuild: "15",
          hasFrontWindow: true,
          loginState: "LOGGED_IN",
          rawEvidence: { source: "test", capturedAt, metadata: {} }
        };
      },
      async openOwnListing() {
        currentId = "own-7506";
        return {
          platformItemId: "own-7506",
          url: "https://detail.example.test/item.htm?id=own-7506",
          shopName: identityJob.ownShopName,
          title: "Sony MDR-7506 own",
          skuDimensions: [],
          pageSkuCount: 1,
          rawEvidence: { source: "test", capturedAt, metadata: {} }
        };
      },
      async search() {
        const positions = [1, 2].map((rank) => ({
          rank,
          platformItemId: null,
          url: sameUrl,
          shopName: `示例店${rank}`,
          title: `示例商品${rank}`,
          displayPriceMinText: "100.00",
          displayPriceMaxText: "100.00",
          sponsored: false,
          capturedAt,
          rawEvidence: { source: "test", capturedAt, metadata: { rank } }
        }));
        return { positions, terminationReason: "LIMIT_REACHED" };
      },
      async openSearchPosition(position) {
        openedRanks.push(position.rank);
        currentId = `stable-item-${position.rank}`;
        return {
          platformItemId: currentId,
          url: `https://item.example.test/item.htm?id=${currentId}`,
          shopName: position.shopName,
          title: position.title,
          skuDimensions: [],
          pageSkuCount: 1,
          rawEvidence: { source: "test", capturedAt, metadata: { rank: position.rank } }
        };
      },
      async selectSku() {
        if (pauseOnSecond && currentId === "stable-item-2" && !paused) {
          paused = true;
          throw new LoginRequiredError("Pause after the first same-URL rank");
        }
        return {
          availability: "AVAILABLE" as const,
          view: {
            selectedLabels: {},
            listPriceText: "100.00",
            activityPriceText: "100.00",
            officialEstimatedPayablePriceText: null,
            promotions: [],
            mandatoryFeeText: "0.00",
            stockState: "IN_STOCK" as const,
            capturedAt,
            rawEvidence: { source: "test", capturedAt, metadata: {} }
          }
        };
      },
      async returnToSearch() { currentId = null; }
    };
  }

  try {
    const store = new AtomicCheckpointStore(join(root, "checkpoints"));
    const pausedDriver = makeDriver(true);
    const pausedReport = await new CollectionRunner(pausedDriver, store)
      .run(identityJob, identityJob.collectorId);
    assert.equal(pausedReport.status, "PAUSED_LOGIN");
    assert.deepEqual(pausedReport.positions.map((position) => position.platformItemId), [
      "stable-item-1", "stable-item-2"
    ]);

    const pausedCheckpoint = await store.load(identityJob.runId);
    assert.ok(pausedCheckpoint);
    const aliases = Object.entries(pausedCheckpoint.identityAliases)
      .filter(([, target]) => target.startsWith("stable-item-"));
    assert.equal(aliases.length, 2);
    assert.equal(new Set(aliases.map(([alias]) => alias)).size, 2);
    assert.equal(aliases.every(([alias]) => alias.startsWith("unresolved:")), true);

    const resumedDriver = makeDriver(false);
    const resumed = await new CollectionRunner(resumedDriver, store)
      .run(identityJob, identityJob.collectorId);
    assert.equal(resumed.status, "SUCCEEDED");
    assert.deepEqual(resumed.competitorItems.map((item) => ({
      id: item.platformItemId,
      ranks: item.searchRanks
    })), [
      { id: "stable-item-1", ranks: [1] },
      { id: "stable-item-2", ranks: [2] }
    ]);
    assert.deepEqual(resumedDriver.openedRanks, [2]);
    assert.doesNotThrow(() => collectorReportSchema.parse(resumed));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pauses a fresh run when diagnosis requires login and resumes without diagnosing again", async () => {
  const root = await mkdtemp(join(tmpdir(), "collector-diagnose-login-"));
  const diagnoseJob = { ...job, runId: "sony-diagnose-login-run" };
  try {
    const store = new AtomicCheckpointStore(join(root, "checkpoints"));
    const blockedFixture = await FixtureDriver.fromFile(fixturePath);
    let blockedDiagnoseCalls = 0;
    const blockedDriver = withDiagnose(blockedFixture, async () => {
      blockedDiagnoseCalls += 1;
      throw new LoginRequiredError("Fixture diagnosis requires login");
    });
    const paused = await new CollectionRunner(blockedDriver, store)
      .run(diagnoseJob, diagnoseJob.collectorId);

    assert.equal(paused.status, "PAUSED_LOGIN");
    assert.equal(paused.appVersion, "unknown");
    assert.equal(blockedDiagnoseCalls, 1);
    assert.equal(blockedFixture.events.length, 0);
    assert.equal((await store.load(diagnoseJob.runId))?.report.status, "PAUSED_LOGIN");
    assert.doesNotThrow(() => collectorReportSchema.parse(paused));

    const healthyFixture = await FixtureDriver.fromFile(fixturePath);
    let resumedDiagnoseCalls = 0;
    const resumedDriver = withDiagnose(healthyFixture, async () => {
      resumedDiagnoseCalls += 1;
      return healthyFixture.diagnose();
    });
    const resumed = await new CollectionRunner(resumedDriver, store)
      .run(diagnoseJob, diagnoseJob.collectorId);
    assert.equal(resumed.status, "SUCCEEDED");
    assert.equal(resumed.appVersion, "unknown");
    assert.equal(resumedDiagnoseCalls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pauses a fresh run when diagnosis encounters a platform challenge without retrying", async () => {
  const root = await mkdtemp(join(tmpdir(), "collector-diagnose-challenge-"));
  const diagnoseJob = { ...job, runId: "sony-diagnose-challenge-run" };
  try {
    const store = new AtomicCheckpointStore(join(root, "checkpoints"));
    const fixture = await FixtureDriver.fromFile(fixturePath);
    let diagnoseCalls = 0;
    const driver = withDiagnose(fixture, async () => {
      diagnoseCalls += 1;
      throw new PlatformChallengeError("Fixture diagnosis encountered a challenge");
    });
    const paused = await new CollectionRunner(driver, store).run(diagnoseJob, diagnoseJob.collectorId);

    assert.equal(paused.status, "PAUSED_CHALLENGE");
    assert.equal(paused.appVersion, "unknown");
    assert.equal(diagnoseCalls, 1);
    assert.equal(fixture.events.length, 0);
    assert.equal((await store.load(diagnoseJob.runId))?.report.status, "PAUSED_CHALLENGE");
    assert.doesNotThrow(() => collectorReportSchema.parse(paused));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sanitizes unreadable selected-SKU evidence errors and leaves the manifest empty", async () => {
  const root = await mkdtemp(join(tmpdir(), "collector-missing-evidence-"));
  const evidenceJob = { ...job, runId: "sony-missing-evidence-run" };
  try {
    const evidencePath = join(root, "private-selected-sku-evidence.png");
    const path = await writeFixtureCopy(root, (fixture) => {
      const view = fixture.ownListings[0]?.item.skuResults[0]?.view;
      assert.ok(view);
      view.evidencePath = evidencePath;
    });
    const store = new AtomicCheckpointStore(join(root, "checkpoints"));
    const report = await new CollectionRunner(await FixtureDriver.fromFile(path), store)
      .run(evidenceJob, evidenceJob.collectorId);

    const evidenceIssue = report.issues.find((entry) =>
      entry.code === "PRICE_UNSTABLE" && entry.platformItemId === "own-7506");
    assert.equal(evidenceIssue?.message, "Selected SKU evidence could not be read");
    assert.equal(JSON.stringify(report).includes(evidencePath), false);
    assert.equal(Object.keys((await store.load(evidenceJob.runId))?.evidenceManifest ?? {}).length, 0);
    assert.doesNotThrow(() => collectorReportSchema.parse(report));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keeps delimiter and duplicate-option-ID combinations distinct across checkpoint resume", async () => {
  const root = await mkdtemp(join(tmpdir(), "collector-sku-collision-"));
  const collisionJob = { ...job, runId: "sony-sku-collision-run" };
  try {
    const path = await writeFixtureCopy(root, (fixture) => {
      const item = fixture.search.items.find((candidate) => candidate.platformItemId === "competitor-b");
      assert.ok(item);
      const template = item.skuResults[0];
      assert.equal(template?.availability, "AVAILABLE");
      assert.ok(template?.view);
      item.pageSkuCount = 6;
      item.skuDimensions = [
        {
          name: "第一维",
          options: [
            { id: "left|shared", label: "甲", enabled: true },
            { id: "left", label: "乙", enabled: true },
            { id: "left", label: "丙", enabled: true }
          ]
        },
        {
          name: "第二维",
          options: [
            { id: "right", label: "丁", enabled: true },
            { id: "shared|right", label: "戊", enabled: true }
          ]
        }
      ];
      item.skuResults = [];
      for (const first of ["甲", "乙", "丙"]) {
        for (const second of ["丁", "戊"]) {
          const selection = { 第一维: first, 第二维: second };
          const result: MutableFixtureResult = structuredClone(template);
          assert.ok(result.view);
          result.selection = selection;
          result.view.selectedLabels = selection;
          item.skuResults.push(result);
        }
      }
    });
    const store = new AtomicCheckpointStore(join(root, "checkpoints"));
    const pausedDriver = await FixtureDriver.fromFile(path, {
      pauseAfterCompletedSkuCount: 7,
      pauseType: "LOGIN_REQUIRED"
    });
    const paused = await new CollectionRunner(pausedDriver, store)
      .run(collisionJob, collisionJob.collectorId);
    assert.equal(paused.status, "PAUSED_LOGIN");

    const resumed = await new CollectionRunner(await FixtureDriver.fromFile(path), store)
      .run(collisionJob, collisionJob.collectorId);
    const item = resumed.competitorItems.find((candidate) => candidate.platformItemId === "competitor-b");
    assert.equal(resumed.status, "SUCCEEDED");
    assert.ok(item);
    assert.equal(item.skus.length, 6);
    assert.equal(new Set(item.skus.map((sku) => sku.skuId)).size, 6);
    assert.equal(item.skus.every((sku) => /^sku_[0-9a-f]{64}$/.test(sku.skuId)), true);
    assert.deepEqual(item.skus.map((sku) => sku.label), [
      "甲 / 丁", "甲 / 戊", "乙 / 丁", "乙 / 戊", "丙 / 丁", "丙 / 戊"
    ]);

    const checkpoint = await store.load(collisionJob.runId);
    assert.equal(checkpoint?.completedSkuKeys.length, 11);
    assert.equal(new Set(checkpoint?.completedSkuKeys).size, 11);
    assert.equal(checkpoint?.completedSkuKeys.every((key) => {
      const parsed: unknown = JSON.parse(key);
      return Array.isArray(parsed) && parsed.length === 2;
    }), true);
    assert.doesNotThrow(() => collectorReportSchema.parse(resumed));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("normalizes a stable-first search URL group before detail traversal", async () => {
  const root = await mkdtemp(join(tmpdir(), "collector-stable-first-"));
  const stableFirstJob = { ...job, runId: "sony-stable-first-run" };
  try {
    const itemUrl = "https://item.example.test/item.htm?id=competitor-a";
    const path = await writeFixtureCopy(root, (fixture) => {
      const matchingPositions = fixture.search.positions.filter((position) => position.url === itemUrl);
      assert.equal(matchingPositions.length, 2);
      matchingPositions[0]!.platformItemId = "competitor-a";
      matchingPositions[1]!.platformItemId = null;
    });
    const driver = await FixtureDriver.fromFile(path);
    const store = new AtomicCheckpointStore(join(root, "checkpoints"));
    const report = await new CollectionRunner(driver, store).run(stableFirstJob, stableFirstJob.collectorId);

    assert.equal(report.status, "SUCCEEDED");
    assert.deepEqual(report.positions.filter((position) => position.url === itemUrl)
      .map((position) => position.platformItemId), ["competitor-a", "competitor-a"]);
    assert.deepEqual(report.competitorItems.find((item) =>
      item.platformItemId === "competitor-a")?.searchRanks, [1, 3]);
    assert.equal(driver.events.filter((event) =>
      event.type === "OPEN_SEARCH_POSITION" && event.platformItemId === "competitor-a").length, 2);

    const fallbackIdentity = unresolvedSearchIdentity(3, itemUrl);
    const checkpoint = await store.load(stableFirstJob.runId);
    assert.equal(checkpoint?.identityAliases[fallbackIdentity], "competitor-a");
    assert.equal(checkpoint?.completedPlatformItemIds.includes(fallbackIdentity), false);
    assert.equal(checkpoint?.completedPlatformItemIds.includes("competitor-a"), true);
    assert.doesNotThrow(() => collectorReportSchema.parse(report));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects conflicting stable search IDs for one canonical URL", async () => {
  const root = await mkdtemp(join(tmpdir(), "collector-search-id-conflict-"));
  const conflictJob = { ...job, runId: "sony-search-id-conflict-run" };
  try {
    const itemUrl = "https://item.example.test/item.htm?id=competitor-a";
    const path = await writeFixtureCopy(root, (fixture) => {
      const matchingPositions = fixture.search.positions.filter((position) => position.url === itemUrl);
      assert.equal(matchingPositions.length, 2);
      matchingPositions[0]!.platformItemId = "search-stable-a";
      matchingPositions[1]!.platformItemId = "search-stable-b";
    });
    const driver = await FixtureDriver.fromFile(path);
    const report = await new CollectionRunner(
      driver,
      new AtomicCheckpointStore(join(root, "checkpoints"))
    ).run(conflictJob, conflictJob.collectorId);

    assert.equal(report.status, "PARTIAL_FAILED");
    assert.equal(report.issues.some((entry) => entry.code === "UI_CONTRACT_CHANGED"
      && entry.message === "Search results exposed conflicting stable item IDs for one canonical URL"), true);
    assert.equal(driver.events.some((event) => event.type === "OPEN_SEARCH_POSITION"), false);
    assert.deepEqual(report.competitorItems, []);
    assert.doesNotThrow(() => collectorReportSchema.parse(report));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("persists a fallback detail alias across pause and resume without duplicate completed SKUs", async () => {
  const root = await mkdtemp(join(tmpdir(), "collector-alias-resume-"));
  const aliasJob = { ...job, runId: "sony-alias-resume-run" };
  try {
    const itemUrl = "https://item.example.test/item.htm?id=competitor-a";
    const firstFallbackIdentity = unresolvedSearchIdentity(1, itemUrl);
    const secondFallbackIdentity = unresolvedSearchIdentity(3, itemUrl);
    const path = await writeFixtureCopy(root, (fixture) => {
      for (const position of fixture.search.positions) {
        if (position.url === itemUrl) position.platformItemId = null;
      }
    });
    const store = new AtomicCheckpointStore(join(root, "checkpoints"));
    const pausedDriver = await FixtureDriver.fromFile(path, {
      pauseAfterCompletedSkuCount: 2,
      pauseType: "LOGIN_REQUIRED"
    });
    const paused = await new CollectionRunner(pausedDriver, store).run(aliasJob, aliasJob.collectorId);
    assert.equal(paused.status, "PAUSED_LOGIN");
    const pausedCheckpoint = await store.load(aliasJob.runId);
    assert.equal(pausedCheckpoint?.identityAliases[firstFallbackIdentity], "competitor-a");
    assert.equal(pausedCheckpoint?.identityAliases[secondFallbackIdentity], undefined);
    assert.deepEqual(paused.positions.filter((position) => position.url === itemUrl)
      .map((position) => position.platformItemId), ["competitor-a", secondFallbackIdentity]);

    const resumedDriver = await FixtureDriver.fromFile(path);
    const resumed = await new CollectionRunner(resumedDriver, store).run(aliasJob, aliasJob.collectorId);
    assert.equal(resumed.status, "SUCCEEDED");
    assert.equal(resumedDriver.events.some((event) => event.type === "SELECT_SKU"
      && event.platformItemId === "competitor-a" && event.completed
      && event.selection["型号"] === "7506 单机"), false);

    const completed = await store.load(aliasJob.runId);
    assert.equal(completed?.completedSkuKeys.length, 6);
    assert.equal(new Set(completed?.completedSkuKeys).size, 6);
    assert.equal(completed?.completedPlatformItemIds.includes(firstFallbackIdentity), false);
    assert.equal(completed?.completedPlatformItemIds.includes(secondFallbackIdentity), false);
    assert.equal(completed?.completedPlatformItemIds.includes("competitor-a"), true);
    assert.equal(completed?.identityAliases[firstFallbackIdentity], "competitor-a");
    assert.equal(completed?.identityAliases[secondFallbackIdentity], "competitor-a");
    assert.doesNotThrow(() => collectorReportSchema.parse(resumed));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a paused fallback-alias SKU completion before duplicate selection or checkpoint rewrite", async () => {
  const root = await mkdtemp(join(tmpdir(), "collector-alias-sku-key-"));
  const aliasJob = { ...job, runId: "sony-alias-sku-key-run" };
  try {
    const itemUrl = "https://item.example.test/item.htm?id=competitor-a";
    const fallbackIdentity = unresolvedSearchIdentity(1, itemUrl);
    const path = await writeFixtureCopy(root, (fixture) => {
      for (const position of fixture.search.positions) {
        if (position.url === itemUrl) position.platformItemId = null;
      }
    });
    const store = new AtomicCheckpointStore(join(root, "checkpoints"));
    await new CollectionRunner(await FixtureDriver.fromFile(path, {
      pauseAfterCompletedSkuCount: 2,
      pauseType: "LOGIN_REQUIRED"
    }), store).run(aliasJob, aliasJob.collectorId);

    const checkpoint = await store.load(aliasJob.runId);
    assert.ok(checkpoint);
    const stableKeyIndex = checkpoint.completedSkuKeys.findIndex((serialized) =>
      (JSON.parse(serialized) as [string, string])[0] === "competitor-a");
    assert.notEqual(stableKeyIndex, -1);
    const [, skuId] = JSON.parse(checkpoint.completedSkuKeys[stableKeyIndex]!) as [string, string];
    checkpoint.completedSkuKeys[stableKeyIndex] = JSON.stringify([fallbackIdentity, skuId]);
    const checkpointPath = store.pathFor(aliasJob.runId);
    const serialized = `${JSON.stringify(checkpoint)}\n`;
    await writeFile(checkpointPath, serialized, "utf8");

    const resumedDriver = await FixtureDriver.fromFile(path);
    await assert.rejects(
      new CollectionRunner(resumedDriver, store).run(aliasJob, aliasJob.collectorId),
      { name: "TypeError", message: "Checkpoint semantic validation failed" }
    );
    assert.deepEqual(resumedDriver.events, []);
    assert.equal(await readFile(checkpointPath, "utf8"), serialized);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects an alias-form completed platform item before driver action or checkpoint rewrite", async () => {
  const root = await mkdtemp(join(tmpdir(), "collector-alias-platform-key-"));
  const aliasJob = { ...job, runId: "sony-alias-platform-key-run" };
  try {
    const itemUrl = "https://item.example.test/item.htm?id=competitor-a";
    const fallbackIdentity = unresolvedSearchIdentity(1, itemUrl);
    const path = await writeFixtureCopy(root, (fixture) => {
      for (const position of fixture.search.positions) {
        if (position.url === itemUrl) position.platformItemId = null;
      }
    });
    const store = new AtomicCheckpointStore(join(root, "checkpoints"));
    await new CollectionRunner(await FixtureDriver.fromFile(path), store)
      .run(aliasJob, aliasJob.collectorId);

    const checkpoint = await store.load(aliasJob.runId);
    assert.ok(checkpoint);
    checkpoint.completedPlatformItemIds = checkpoint.completedPlatformItemIds
      .filter((identity) => identity !== fallbackIdentity)
      .map((identity) => identity === "competitor-a" ? fallbackIdentity : identity);
    const checkpointPath = store.pathFor(aliasJob.runId);
    const serialized = `${JSON.stringify(checkpoint)}\n`;
    await writeFile(checkpointPath, serialized, "utf8");

    const resumedDriver = await FixtureDriver.fromFile(path);
    await assert.rejects(
      new CollectionRunner(resumedDriver, store).run(aliasJob, aliasJob.collectorId),
      { name: "TypeError", message: "Checkpoint semantic validation failed" }
    );
    assert.deepEqual(resumedDriver.events, []);
    assert.equal(await readFile(checkpointPath, "utf8"), serialized);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects stable search ID A when detail returns stable ID B", async () => {
  const root = await mkdtemp(join(tmpdir(), "collector-detail-id-mismatch-"));
  const mismatchJob = { ...job, runId: "sony-detail-id-mismatch-run" };
  try {
    const itemUrl = "https://item.example.test/item.htm?id=competitor-a";
    const path = await writeFixtureCopy(root, (fixture) => {
      for (const position of fixture.search.positions) {
        if (position.url === itemUrl) position.platformItemId = "search-stable-a";
      }
    });
    const report = await new CollectionRunner(
      await FixtureDriver.fromFile(path),
      new AtomicCheckpointStore(join(root, "checkpoints"))
    ).run(mismatchJob, mismatchJob.collectorId);

    assert.equal(report.status, "PARTIAL_FAILED");
    assert.equal(report.issues.some((entry) => entry.code === "UI_CONTRACT_CHANGED"
      && entry.message === "Search item identity changed during detail traversal"), true);
    assert.deepEqual(report.positions.filter((position) => position.url === itemUrl)
      .map((position) => position.platformItemId), ["search-stable-a", "search-stable-a"]);
    assert.equal(report.competitorItems.some((item) => item.platformItemId === "competitor-a"), false);
    assert.doesNotThrow(() => collectorReportSchema.parse(report));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a legacy schema-version-1 checkpoint before any driver action", async () => {
  const root = await mkdtemp(join(tmpdir(), "collector-legacy-checkpoint-"));
  const legacyJob = { ...job, runId: "sony-legacy-checkpoint-run" };
  try {
    const store = new AtomicCheckpointStore(join(root, "checkpoints"));
    const checkpointPath = store.pathFor(legacyJob.runId);
    await mkdir(dirname(checkpointPath), { recursive: true });
    await writeFile(checkpointPath, JSON.stringify({
      schemaVersion: 1,
      runId: legacyJob.runId,
      jobHash: "sha256:legacy-format",
      phase: "OWN_LISTINGS",
      completedOwnListingIds: [],
      completedPlatformItemIds: [],
      completedSkuKeys: [],
      report: {
        schemaVersion: 1,
        runId: legacyJob.runId,
        collectorId: legacyJob.collectorId,
        appVersion: "unknown",
        startedAt: "2026-08-24T05:00:00.000Z",
        completedAt: "2026-08-24T05:00:00.000Z",
        status: "PAUSED_LOGIN",
        searchLimit: legacyJob.searchLimit,
        positions: [],
        ownItems: [],
        competitorItems: [],
        issues: [{
          code: "LOGIN_REQUIRED",
          message: "Legacy checkpoint",
          capturedAt: "2026-08-24T05:00:00.000Z"
        }]
      },
      evidenceManifest: {}
    }), "utf8");

    await assert.rejects(store.load(legacyJob.runId), /checkpoint format version/i);
    const fixture = await FixtureDriver.fromFile(fixturePath);
    let diagnoseCalls = 0;
    const driver = withDiagnose(fixture, async () => {
      diagnoseCalls += 1;
      return fixture.diagnose();
    });
    await assert.rejects(
      new CollectionRunner(driver, store).run(legacyJob, legacyJob.collectorId),
      /checkpoint format version/i
    );
    assert.equal(diagnoseCalls, 0);
    assert.equal(fixture.events.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a corrupt format-2 checkpoint before driver action without rewriting it", async () => {
  const root = await mkdtemp(join(tmpdir(), "collector-corrupt-checkpoint-"));
  const corruptJob = { ...job, runId: "sony-corrupt-checkpoint-run" };
  try {
    const store = new AtomicCheckpointStore(join(root, "checkpoints"));
    const checkpointPath = store.pathFor(corruptJob.runId);
    const corruptCheckpoint = {
      schemaVersion: 1,
      checkpointFormatVersion: 2,
      runId: corruptJob.runId,
      jobHash: hashCollectorJob(corruptJob),
      phase: "OWN_LISTINGS",
      completedOwnListingIds: [],
      completedPlatformItemIds: [],
      completedSkuKeys: [],
      report: {
        schemaVersion: 1,
        runId: corruptJob.runId,
        collectorId: corruptJob.collectorId,
        appVersion: "fixture-1.0",
        startedAt: "not-a-timestamp",
        completedAt: "also-not-a-timestamp",
        status: "CORRUPTED",
        searchLimit: corruptJob.searchLimit,
        positions: [],
        ownItems: [{
          ownListingId: "broken-own-item",
          platformItemId: "broken-platform-item",
          url: "not-a-url",
          shopName: "",
          title: "",
          searchRanks: [],
          skus: [{ skuId: "not-a-current-sku" }]
        }],
        competitorItems: [],
        issues: []
      },
      evidenceManifest: {},
      identityAliases: {}
    };
    const serialized = `${JSON.stringify(corruptCheckpoint)}\n`;
    await mkdir(dirname(checkpointPath), { recursive: true });
    await writeFile(checkpointPath, serialized, "utf8");

    const fixture = await FixtureDriver.fromFile(fixturePath);
    let diagnoseCalls = 0;
    const driver = withDiagnose(fixture, async () => {
      diagnoseCalls += 1;
      return fixture.diagnose();
    });
    await assert.rejects(
      new CollectionRunner(driver, store).run(corruptJob, corruptJob.collectorId),
      { name: "TypeError", message: "Checkpoint validation failed" }
    );
    assert.equal(diagnoseCalls, 0);
    assert.equal(fixture.events.length, 0);
    assert.equal(await readFile(checkpointPath, "utf8"), serialized);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a ghost-completed own listing before every driver action without rewriting it", async () => {
  const root = await mkdtemp(join(tmpdir(), "collector-ghost-own-checkpoint-"));
  const ghostJob = { ...job, runId: "sony-ghost-own-checkpoint-run" };
  try {
    const store = new AtomicCheckpointStore(join(root, "checkpoints"));
    const checkpointPath = store.pathFor(ghostJob.runId);
    const ghostCheckpoint = emptyCheckpoint(ghostJob);
    ghostCheckpoint.completedOwnListingIds = ["own-listing-7506"];
    const serialized = `${JSON.stringify(ghostCheckpoint)}\n`;
    await mkdir(dirname(checkpointPath), { recursive: true });
    await writeFile(checkpointPath, serialized, "utf8");

    const fixture = await FixtureDriver.fromFile(fixturePath);
    let diagnoseCalls = 0;
    const driver = withDiagnose(fixture, async () => {
      diagnoseCalls += 1;
      return fixture.diagnose();
    });
    await assert.rejects(
      new CollectionRunner(driver, store).run(ghostJob, ghostJob.collectorId),
      { name: "TypeError", message: "Checkpoint semantic validation failed" }
    );
    assert.equal(diagnoseCalls, 0);
    assert.deepEqual(fixture.events, []);
    assert.equal(await readFile(checkpointPath, "utf8"), serialized);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a checkpoint report for the wrong collector before every driver action without rewriting it", async () => {
  const root = await mkdtemp(join(tmpdir(), "collector-wrong-report-collector-"));
  const collectorJob = { ...job, runId: "sony-wrong-report-collector-run" };
  try {
    const store = new AtomicCheckpointStore(join(root, "checkpoints"));
    const checkpointPath = store.pathFor(collectorJob.runId);
    const wrongCollectorCheckpoint = emptyCheckpoint(collectorJob, "collector-tampered");
    const serialized = `${JSON.stringify(wrongCollectorCheckpoint)}\n`;
    await mkdir(dirname(checkpointPath), { recursive: true });
    await writeFile(checkpointPath, serialized, "utf8");

    const fixture = await FixtureDriver.fromFile(fixturePath);
    let diagnoseCalls = 0;
    const driver = withDiagnose(fixture, async () => {
      diagnoseCalls += 1;
      return fixture.diagnose();
    });
    await assert.rejects(
      new CollectionRunner(driver, store).run(collectorJob, collectorJob.collectorId),
      { name: "TypeError", message: "Checkpoint semantic validation failed" }
    );
    assert.equal(diagnoseCalls, 0);
    assert.deepEqual(fixture.events, []);
    assert.equal(await readFile(checkpointPath, "utf8"), serialized);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects PAUSED_LOGIN without LOGIN_REQUIRED before every driver action without rewriting it", async () => {
  const root = await mkdtemp(join(tmpdir(), "collector-missing-login-issue-"));
  const pausedJob = { ...job, runId: "sony-missing-login-issue-run" };
  try {
    const store = new AtomicCheckpointStore(join(root, "checkpoints"));
    const checkpointPath = store.pathFor(pausedJob.runId);
    const checkpoint = emptyCheckpoint(pausedJob);
    checkpoint.report.status = "PAUSED_LOGIN";
    const serialized = `${JSON.stringify(checkpoint)}\n`;
    await mkdir(dirname(checkpointPath), { recursive: true });
    await writeFile(checkpointPath, serialized, "utf8");

    const fixture = await FixtureDriver.fromFile(fixturePath);
    let diagnoseCalls = 0;
    const driver = withDiagnose(fixture, async () => {
      diagnoseCalls += 1;
      return fixture.diagnose();
    });
    await assert.rejects(
      new CollectionRunner(driver, store).run(pausedJob, pausedJob.collectorId),
      { name: "TypeError", message: "Checkpoint semantic validation failed" }
    );
    assert.equal(diagnoseCalls, 0);
    assert.deepEqual(fixture.events, []);
    assert.equal(await readFile(checkpointPath, "utf8"), serialized);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects incompatible pause statuses and issues at incomplete and complete boundaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "collector-pause-coherence-"));
  const coherenceJob = { ...job, runId: "sony-pause-coherence-run" };
  const capturedAt = "2026-08-24T05:00:00.000Z";
  const loginIssue = { code: "LOGIN_REQUIRED" as const, message: "Login required", capturedAt };
  const challengeIssue = {
    code: "PLATFORM_CHALLENGE" as const,
    message: "Platform challenge",
    capturedAt
  };
  try {
    const completeStore = new AtomicCheckpointStore(join(root, "source"));
    await new CollectionRunner(await FixtureDriver.fromFile(fixturePath), completeStore)
      .run(coherenceJob, coherenceJob.collectorId);
    const complete = await completeStore.load(coherenceJob.runId);
    assert.ok(complete);

    const cases: Array<{ name: string; checkpoint: CollectorCheckpoint }> = [
      {
        name: "PAUSED_CHALLENGE without PLATFORM_CHALLENGE",
        checkpoint: { ...emptyCheckpoint(coherenceJob), report: {
          ...emptyCheckpoint(coherenceJob).report,
          status: "PAUSED_CHALLENGE"
        } }
      },
      {
        name: "PAUSED_LOGIN with challenge issue",
        checkpoint: { ...emptyCheckpoint(coherenceJob), report: {
          ...emptyCheckpoint(coherenceJob).report,
          status: "PAUSED_LOGIN",
          issues: [challengeIssue]
        } }
      },
      {
        name: "PAUSED_CHALLENGE with login issue",
        checkpoint: { ...emptyCheckpoint(coherenceJob), report: {
          ...emptyCheckpoint(coherenceJob).report,
          status: "PAUSED_CHALLENGE",
          issues: [loginIssue]
        } }
      },
      {
        name: "active checkpoint with login issue",
        checkpoint: { ...emptyCheckpoint(coherenceJob), report: {
          ...emptyCheckpoint(coherenceJob).report,
          issues: [loginIssue]
        } }
      },
      {
        name: "active checkpoint with challenge issue",
        checkpoint: { ...emptyCheckpoint(coherenceJob), report: {
          ...emptyCheckpoint(coherenceJob).report,
          issues: [challengeIssue]
        } }
      },
      {
        name: "SUCCEEDED checkpoint with login issue",
        checkpoint: { ...structuredClone(complete), report: {
          ...structuredClone(complete.report),
          issues: [...complete.report.issues, loginIssue]
        } }
      },
      {
        name: "SUCCEEDED checkpoint with challenge issue",
        checkpoint: { ...structuredClone(complete), report: {
          ...structuredClone(complete.report),
          issues: [...complete.report.issues, challengeIssue]
        } }
      },
      {
        name: "COMPLETE checkpoint paused for login",
        checkpoint: { ...structuredClone(complete), report: {
          ...structuredClone(complete.report),
          status: "PAUSED_LOGIN",
          issues: [...complete.report.issues, loginIssue]
        } }
      },
      {
        name: "COMPLETE checkpoint paused for challenge",
        checkpoint: { ...structuredClone(complete), report: {
          ...structuredClone(complete.report),
          status: "PAUSED_CHALLENGE",
          issues: [...complete.report.issues, challengeIssue]
        } }
      }
    ];

    for (const [index, testCase] of cases.entries()) {
      const store = new AtomicCheckpointStore(join(root, "cases", String(index)));
      const checkpointPath = store.pathFor(coherenceJob.runId);
      const serialized = `${JSON.stringify(testCase.checkpoint)}\n`;
      await mkdir(dirname(checkpointPath), { recursive: true });
      await writeFile(checkpointPath, serialized, "utf8");

      const fixture = await FixtureDriver.fromFile(fixturePath);
      let diagnoseCalls = 0;
      const driver = withDiagnose(fixture, async () => {
        diagnoseCalls += 1;
        return fixture.diagnose();
      });
      await assert.rejects(
        new CollectionRunner(driver, store).run(coherenceJob, coherenceJob.collectorId),
        { name: "TypeError", message: "Checkpoint semantic validation failed" },
        testCase.name
      );
      assert.equal(diagnoseCalls, 0, testCase.name);
      assert.deepEqual(fixture.events, [], testCase.name);
      assert.equal(await readFile(checkpointPath, "utf8"), serialized, testCase.name);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects shape-valid checkpoints that contradict job, progress, alias, phase, or evidence semantics", async () => {
  const root = await mkdtemp(join(tmpdir(), "collector-semantic-checkpoint-"));
  const semanticJob = { ...job, runId: "sony-semantic-checkpoint-run" };
  try {
    const store = new RecordingCheckpointStore(join(root, "checkpoints"));
    await new CollectionRunner(await FixtureDriver.fromFile(fixturePath), store)
      .run(semanticJob, semanticJob.collectorId);
    const complete = await store.load(semanticJob.runId);
    assert.ok(complete);
    const canonicalCompetitorBUrl = new URL("https://item.example.test/item.htm?id=competitor-b").toString();
    const unknownSkuId = `sku_${"f".repeat(64)}`;
    const unknownEvidenceKey = `sha256:${"e".repeat(64)}`;

    const tamperCases: Array<{
      name: string;
      mutate(checkpoint: CollectorCheckpoint): void;
    }> = [
      {
        name: "report search limit",
        mutate: (checkpoint) => {
          checkpoint.report.searchLimit = semanticJob.searchLimit + 1;
          checkpoint.report.searchTerminationReason = "END_MARKER";
        }
      },
      {
        name: "own listing identity",
        mutate: (checkpoint) => {
          checkpoint.report.ownItems[0]!.ownListingId = "wrong-own-listing";
          checkpoint.completedOwnListingIds = ["wrong-own-listing"];
        }
      },
      {
        name: "own listing URL",
        mutate: (checkpoint) => {
          checkpoint.report.ownItems[0]!.url = "https://detail.example.test/item.htm?id=other-product";
        }
      },
      {
        name: "own shop identity",
        mutate: (checkpoint) => { checkpoint.report.ownItems[0]!.shopName = "Different shop"; }
      },
      {
        name: "ghost completed platform item",
        mutate: (checkpoint) => { checkpoint.completedPlatformItemIds.push("ghost-item"); }
      },
      {
        name: "ghost completed SKU",
        mutate: (checkpoint) => {
          checkpoint.completedSkuKeys.push(JSON.stringify(["competitor-a", unknownSkuId]));
        }
      },
      {
        name: "uncommitted report SKU",
        mutate: (checkpoint) => { checkpoint.completedSkuKeys.shift(); }
      },
      {
        name: "rank alias identity",
        mutate: (checkpoint) => {
          checkpoint.identityAliases[canonicalCompetitorBUrl] = "competitor-a";
        }
      },
      {
        name: "phase progress",
        mutate: (checkpoint) => {
          checkpoint.phase = "OWN_LISTINGS";
          checkpoint.report.status = "FAILED";
        }
      },
      {
        name: "complete status",
        mutate: (checkpoint) => { checkpoint.report.status = "PAUSED_LOGIN"; }
      },
      {
        name: "complete result status",
        mutate: (checkpoint) => { checkpoint.report.status = "PARTIAL_FAILED"; }
      },
      {
        name: "missing evidence manifest entry",
        mutate: (checkpoint) => { checkpoint.report.ownItems[0]!.skus[0]!.evidenceKey = unknownEvidenceKey; }
      }
    ];

    for (const tamperCase of tamperCases) {
      const checkpoint: CollectorCheckpoint = structuredClone(complete);
      tamperCase.mutate(checkpoint);
      const serialized: string = `${JSON.stringify(checkpoint)}\n`;
      await writeFile(store.pathFor(semanticJob.runId), serialized, "utf8");

      const fixture = await FixtureDriver.fromFile(fixturePath);
      let diagnoseCalls = 0;
      const driver = withDiagnose(fixture, async () => {
        diagnoseCalls += 1;
        return fixture.diagnose();
      });
      await assert.rejects(
        new CollectionRunner(driver, store).run(semanticJob, semanticJob.collectorId),
        { name: "TypeError", message: "Checkpoint semantic validation failed" },
        tamperCase.name
      );
      assert.equal(diagnoseCalls, 0, tamperCase.name);
      assert.deepEqual(fixture.events, [], tamperCase.name);
      assert.equal(await readFile(store.pathFor(semanticJob.runId), "utf8"), serialized, tamperCase.name);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resumes every persisted successful and paused workflow boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "collector-checkpoint-boundaries-"));
  const boundaryJob = { ...job, runId: "sony-checkpoint-boundaries-run" };
  try {
    const successfulStore = new RecordingCheckpointStore(join(root, "successful"));
    await new CollectionRunner(await FixtureDriver.fromFile(fixturePath), successfulStore)
      .run(boundaryJob, boundaryJob.collectorId);

    const pausedStore = new RecordingCheckpointStore(join(root, "paused"));
    const pausedReport = await new CollectionRunner(await FixtureDriver.fromFile(fixturePath, {
      pauseAfterCompletedSkuCount: 1,
      pauseType: "LOGIN_REQUIRED"
    }), pausedStore).run(boundaryJob, boundaryJob.collectorId);
    assert.equal(pausedReport.status, "PAUSED_LOGIN");

    const challengedStore = new RecordingCheckpointStore(join(root, "challenged"));
    const challengedReport = await new CollectionRunner(await FixtureDriver.fromFile(fixturePath, {
      pauseAfterCompletedSkuCount: 1,
      pauseType: "PLATFORM_CHALLENGE"
    }), challengedStore).run(boundaryJob, boundaryJob.collectorId);
    assert.equal(challengedReport.status, "PAUSED_CHALLENGE");

    const snapshots = [
      ...successfulStore.snapshots,
      ...pausedStore.snapshots,
      ...challengedStore.snapshots
    ];
    assert.equal(snapshots.some((snapshot) => snapshot.phase === "OWN_LISTINGS"), true);
    assert.equal(snapshots.some((snapshot) => snapshot.phase === "SEARCH"), true);
    assert.equal(snapshots.some((snapshot) => snapshot.phase === "ITEMS"), true);
    assert.equal(snapshots.some((snapshot) => snapshot.phase === "COMPLETE"), true);
    assert.equal(snapshots.some((snapshot) => snapshot.report.status === "PAUSED_LOGIN"), true);
    assert.equal(snapshots.some((snapshot) => snapshot.report.status === "PAUSED_CHALLENGE"), true);

    for (const [index, snapshot] of snapshots.entries()) {
      const replayStore = new AtomicCheckpointStore(join(root, "replays", String(index)));
      await replayStore.save(boundaryJob.runId, snapshot);
      const resumed = await new CollectionRunner(await FixtureDriver.fromFile(fixturePath), replayStore)
        .run(boundaryJob, boundaryJob.collectorId);
      assert.equal(resumed.status, "SUCCEEDED", `snapshot ${index} at ${snapshot.phase}`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resumes issue-backed terminal SKU checkpoints without retrying completed outcomes", async () => {
  const root = await mkdtemp(join(tmpdir(), "collector-terminal-issue-resume-"));
  try {
    const variants: Array<{
      name: string;
      mutate(fixture: MutableFixture): void;
    }> = [
      {
        name: "unavailable",
        mutate: (fixture) => {
          const result = fixture.ownListings[0]!.item.skuResults[0]!;
          fixture.ownListings[0]!.item.skuResults = [{
            selection: result.selection,
            availability: "UNAVAILABLE",
            reason: "Unavailable fixture outcome"
          }];
        }
      },
      {
        name: "selection-mismatch",
        mutate: (fixture) => {
          fixture.ownListings[0]!.item.skuResults[0]!.view!.selectedLabels = { 配置: "Different SKU" };
        }
      },
      {
        name: "unstable-price",
        mutate: (fixture) => {
          fixture.ownListings[0]!.item.skuResults[0]!.view!.activityPriceText = null;
        }
      }
    ];

    for (const [index, variant] of variants.entries()) {
      const path = await writeFixtureCopy(root, variant.mutate);
      const variantJob = { ...job, runId: `sony-terminal-${index}-run` };
      const store = new AtomicCheckpointStore(join(root, "checkpoints", String(index)));
      const paused = await new CollectionRunner(await FixtureDriver.fromFile(path, {
        pauseAfterCompletedSkuCount: 1,
        pauseType: "LOGIN_REQUIRED"
      }), store).run(variantJob, variantJob.collectorId);
      assert.equal(paused.status, "PAUSED_LOGIN", variant.name);

      const resumedDriver = await FixtureDriver.fromFile(path);
      const resumed = await new CollectionRunner(resumedDriver, store)
        .run(variantJob, variantJob.collectorId);
      assert.equal(resumed.status, "PARTIAL_FAILED", variant.name);
      assert.equal(resumedDriver.events.some((event) => event.type === "SELECT_SKU"
        && event.platformItemId === "own-7506"), false, variant.name);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports typed startup and missing-identity driver outcomes without claiming completion", async () => {
  const root = await mkdtemp(join(tmpdir(), "collector-driver-issues-"));
  try {
    const startupBase = await FixtureDriver.fromFile(fixturePath);
    const startupDriver = withDiagnose(startupBase, async () => {
      throw new DriverIssueError(
        "APP_VERSION_UNSUPPORTED",
        "Unsupported Taobao Desktop version 2.4.6 build 16."
      );
    });
    const startupReport = await new CollectionRunner(
      startupDriver,
      new AtomicCheckpointStore(join(root, "startup"))
    ).run({ ...job, runId: "driver-startup-issue" }, job.collectorId);
    assert.equal(startupReport.status, "FAILED");
    assert.equal(startupReport.issues.some((entry) => entry.code === "APP_VERSION_UNSUPPORTED"), true);

    const missingBase = await FixtureDriver.fromFile(fixturePath);
    const missingDriver: TaobaoDesktopDriver = {
      diagnose: () => missingBase.diagnose(),
      openOwnListing: (url) => missingBase.openOwnListing(url),
      search: async (query, limit) => {
        const result = await missingBase.search(query, limit);
        return {
          ...result,
          positions: result.positions.map((position, index) => index === 0
            ? { ...position, platformItemId: null, url: "https://item.example.test/unresolved" }
            : position)
        };
      },
      openSearchPosition: async () => {
        throw new DriverIssueError("MISSING_ITEM_ID", "A stable Taobao item ID was not available.");
      },
      selectSku: (selection) => missingBase.selectSku(selection),
      returnToSearch: () => missingBase.returnToSearch()
    };
    const missingReport = await new CollectionRunner(
      missingDriver,
      new AtomicCheckpointStore(join(root, "missing"))
    ).run({ ...job, runId: "driver-missing-id" }, job.collectorId);
    assert.equal(missingReport.status, "PARTIAL_FAILED");
    assert.equal(missingReport.issues.some((entry) => entry.code === "MISSING_ITEM_ID"), true);
    assert.equal(missingReport.competitorItems.length, 0);
    assert.equal(missingReport.positions.some((entry) => entry.platformItemId === entry.url), false);

    const unstableBase = await FixtureDriver.fromFile(fixturePath);
    const unstableDriver: TaobaoDesktopDriver = {
      diagnose: () => unstableBase.diagnose(),
      openOwnListing: (url) => unstableBase.openOwnListing(url),
      search: (query, limit) => unstableBase.search(query, limit),
      openSearchPosition: (position) => unstableBase.openSearchPosition(position),
      selectSku: async () => {
        throw new DriverSkuIssueError("PRICE_UNSTABLE", "Selected-SKU price evidence did not stabilize.");
      },
      returnToSearch: () => unstableBase.returnToSearch()
    };
    const unstableReport = await new CollectionRunner(
      unstableDriver,
      new AtomicCheckpointStore(join(root, "unstable"))
    ).run({ ...job, runId: "driver-price-unstable" }, job.collectorId);
    assert.equal(unstableReport.status, "PARTIAL_FAILED");
    assert.equal(unstableReport.issues.some((entry) => entry.code === "PRICE_UNSTABLE"
      && entry.platformItemId === "own-7506"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
