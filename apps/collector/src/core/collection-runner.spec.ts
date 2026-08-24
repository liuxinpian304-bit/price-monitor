import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import type { CollectorJob } from "@stau-price-monitor/contracts";

import { AtomicCheckpointStore, type CollectorCheckpoint } from "./checkpoint-store.ts";
import { CollectionRunner } from "./collection-runner.ts";
import { FixtureDriver } from "../drivers/fixture/fixture-driver.ts";
import type { TaobaoDesktopDriver } from "./desktop-driver.ts";

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

interface MutableFixture {
  ownListings: Array<{ item: { skuResults: MutableFixtureResult[] } }>;
  search: {
    positions: Array<{ platformItemId: string | null; url: string }>;
    items: Array<{ platformItemId: string | null; skuResults: MutableFixtureResult[] }>;
  };
}

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
      && entry.platformItemId === "competitor-b" && entry.skuId === "b-bare"
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
      entry.code === "SKU_SELECTION_MISMATCH" && entry.skuId === "a-bare"), true);
    assert.equal(report.issues.some((entry) =>
      entry.code === "PRICE_UNSTABLE" && entry.skuId === "a-cable"), true);
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
