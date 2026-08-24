import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { collectorReportSchema, type CollectorJob } from "@stau-price-monitor/contracts";

import { AtomicCheckpointStore, type CollectorCheckpoint } from "./checkpoint-store.ts";
import { CollectionRunner, hashCollectorJob } from "./collection-runner.ts";
import { FixtureDriver } from "../drivers/fixture/fixture-driver.ts";
import {
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

test("uses canonical URL fallback without presenting it to the driver as a stable item ID", async () => {
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

    const fallbackIdentity = new URL(itemUrl).toString();
    assert.deepEqual(report.positions.filter((position) => position.url === itemUrl)
      .map((position) => position.platformItemId), [fallbackIdentity, fallbackIdentity]);
    assert.deepEqual(report.competitorItems.find((item) =>
      item.platformItemId === fallbackIdentity)?.searchRanks, [1, 3]);
    assert.equal(fixtureDriver.events.filter((event) =>
      event.type === "OPEN_SEARCH_POSITION" && event.platformItemId === null).length, 1);
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
    const fallbackIdentity = new URL(itemUrl).toString();
    assert.equal(checkpoint?.completedPlatformItemIds.includes(fallbackIdentity), true);
    assert.equal(checkpoint?.completedPlatformItemIds.includes("competitor-a"), true);
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
      event.type === "OPEN_SEARCH_POSITION" && event.platformItemId === "competitor-a").length, 1);

    const fallbackIdentity = new URL(itemUrl).toString();
    const checkpoint = await store.load(stableFirstJob.runId);
    assert.equal(checkpoint?.identityAliases[fallbackIdentity], "competitor-a");
    assert.equal(checkpoint?.completedPlatformItemIds.includes(fallbackIdentity), true);
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
    const fallbackIdentity = new URL(itemUrl).toString();
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
    assert.equal(pausedCheckpoint?.identityAliases[fallbackIdentity], "competitor-a");
    assert.deepEqual(paused.positions.filter((position) => position.url === itemUrl)
      .map((position) => position.platformItemId), ["competitor-a", "competitor-a"]);

    const resumedDriver = await FixtureDriver.fromFile(path);
    const resumed = await new CollectionRunner(resumedDriver, store).run(aliasJob, aliasJob.collectorId);
    assert.equal(resumed.status, "SUCCEEDED");
    assert.equal(resumedDriver.events.some((event) => event.type === "SELECT_SKU"
      && event.platformItemId === "competitor-a" && event.completed
      && event.selection["型号"] === "7506 单机"), false);

    const completed = await store.load(aliasJob.runId);
    assert.equal(completed?.completedSkuKeys.length, 6);
    assert.equal(new Set(completed?.completedSkuKeys).size, 6);
    assert.equal(completed?.completedPlatformItemIds.includes(fallbackIdentity), true);
    assert.equal(completed?.completedPlatformItemIds.includes("competitor-a"), true);
    assert.equal(completed?.identityAliases[fallbackIdentity], "competitor-a");
    assert.doesNotThrow(() => collectorReportSchema.parse(resumed));
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
