import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import type { CollectorReport } from "@stau-price-monitor/contracts";

import { AtomicCheckpointStore, type CollectorCheckpoint } from "./checkpoint-store.ts";

const capturedAt = "2026-08-24T05:00:00.000Z";

function report(status: CollectorReport["status"]): CollectorReport {
  return {
    schemaVersion: 1,
    runId: "run-1",
    collectorId: "collector-1",
    appVersion: "fixture-1.0",
    startedAt: capturedAt,
    completedAt: capturedAt,
    status,
    searchLimit: 3,
    positions: [],
    ownItems: [],
    competitorItems: [],
    issues: []
  };
}

function checkpoint(phase: CollectorCheckpoint["phase"]): CollectorCheckpoint {
  return {
    schemaVersion: 1,
    checkpointFormatVersion: 2,
    runId: "run-1",
    jobHash: `sha256:${"1".repeat(64)}`,
    phase,
    completedOwnListingIds: [],
    completedPlatformItemIds: [],
    completedSkuKeys: [],
    report: report(phase === "COMPLETE" ? "SUCCEEDED" : "FAILED"),
    evidenceManifest: {},
    identityAliases: {}
  };
}

async function writeRawCheckpoint(
  store: AtomicCheckpointStore,
  value: unknown
): Promise<void> {
  const path = store.pathFor("run-1");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value)}\n`, "utf8");
}

test("atomically replaces a checkpoint without leaking unrelated process secrets", async () => {
  const root = await mkdtemp(join(tmpdir(), "collector-checkpoint-"));
  const pairingToken = "pairing-token-must-never-be-persisted";
  const unrelatedSecret = "unrelated-process-secret-must-never-be-persisted";
  const previousPairingToken = process.env.COLLECTOR_PAIRING_TOKEN;
  const previousWebhookSecret = process.env.WEBHOOK_SECRET;
  process.env.COLLECTOR_PAIRING_TOKEN = pairingToken;
  process.env.WEBHOOK_SECRET = unrelatedSecret;

  try {
    const store = new AtomicCheckpointStore(root);
    await store.save("run-1", checkpoint("SEARCH"));
    await store.save("run-1", checkpoint("COMPLETE"));

    assert.equal(store.pathFor("run-1"), join(root, "run-1", "checkpoint.json"));
    assert.equal((await store.load("run-1"))?.phase, "COMPLETE");

    const runFiles = await readdir(join(root, "run-1"));
    assert.deepEqual(runFiles, ["checkpoint.json"]);

    const serialized = await readFile(store.pathFor("run-1"), "utf8");
    const persisted = JSON.parse(serialized) as CollectorCheckpoint;
    assert.equal(persisted.phase, "COMPLETE");
    assert.equal(serialized.includes(pairingToken), false);
    assert.equal(serialized.includes(unrelatedSecret), false);
    assert.equal(runFiles.some((name) => name.includes(pairingToken) || name.includes(unrelatedSecret)), false);

    await store.remove("run-1");
    assert.equal(await store.load("run-1"), null);
  } finally {
    if (previousPairingToken === undefined) delete process.env.COLLECTOR_PAIRING_TOKEN;
    else process.env.COLLECTOR_PAIRING_TOKEN = previousPairingToken;
    if (previousWebhookSecret === undefined) delete process.env.WEBHOOK_SECRET;
    else process.env.WEBHOOK_SECRET = previousWebhookSecret;
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a run ID that could escape the checkpoint root", async () => {
  const root = await mkdtemp(join(tmpdir(), "collector-checkpoint-"));
  try {
    const store = new AtomicCheckpointStore(root);
    assert.throws(() => store.pathFor("../escaped"), /run ID/i);
    await assert.rejects(store.save("nested/run", checkpoint("SEARCH")), /run ID/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects malformed format-2 nested report data with one deterministic error", async () => {
  const root = await mkdtemp(join(tmpdir(), "collector-checkpoint-invalid-report-"));
  try {
    const store = new AtomicCheckpointStore(root);
    const invalidStatusAndTimestamps = structuredClone(checkpoint("ITEMS")) as unknown as {
      report: Record<string, unknown>;
    };
    invalidStatusAndTimestamps.report.status = "CORRUPTED";
    invalidStatusAndTimestamps.report.startedAt = "not-a-timestamp";

    const malformedOwnObservation = structuredClone(checkpoint("ITEMS")) as unknown as {
      report: Record<string, unknown>;
    };
    malformedOwnObservation.report.ownItems = [{
      ownListingId: "own-1",
      platformItemId: "item-1",
      url: "https://item.example.test/item.htm?id=item-1",
      shopName: "Fixture shop",
      title: "Fixture item",
      searchRanks: [],
      skus: [{
        skuId: `sku_${"a".repeat(64)}`,
        label: "",
        attributes: {},
        stockState: "IN_STOCK",
        listPriceFen: -1,
        activityPriceFen: 100,
        couponDiscountFen: 0,
        fullReductionFen: 0,
        directDiscountFen: 0,
        promotions: [],
        mandatoryFeeFen: 0,
        priceConfidence: "CONFIRMED",
        payableFen: 100,
        capturedAt: "not-a-timestamp",
        evidenceKey: null
      }]
    }];

    for (const malformed of [invalidStatusAndTimestamps, malformedOwnObservation]) {
      await writeRawCheckpoint(store, malformed);
      await assert.rejects(store.load("run-1"), {
        name: "TypeError",
        message: "Checkpoint validation failed"
      });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects malformed checkpoint progress and completion keys", async () => {
  const root = await mkdtemp(join(tmpdir(), "collector-checkpoint-invalid-progress-"));
  try {
    const store = new AtomicCheckpointStore(root);
    const malformedValues = [
      { completedOwnListingIds: [""] },
      { completedPlatformItemIds: [""] },
      { completedSkuKeys: ["item-1:sku-old-format"] },
      { completedSkuKeys: [JSON.stringify(["item-1", "not-a-hashed-sku-id"])] }
    ];
    for (const replacement of malformedValues) {
      await writeRawCheckpoint(store, { ...checkpoint("ITEMS"), ...replacement });
      await assert.rejects(store.load("run-1"), {
        name: "TypeError",
        message: "Checkpoint validation failed"
      });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects empty, self-referential, and cyclic identity aliases", async () => {
  const root = await mkdtemp(join(tmpdir(), "collector-checkpoint-invalid-aliases-"));
  try {
    const store = new AtomicCheckpointStore(root);
    for (const identityAliases of [
      { "": "stable-id" },
      { "fallback-id": "" },
      { "same-id": "same-id" },
      { "fallback-a": "fallback-b", "fallback-b": "fallback-a" }
    ]) {
      await writeRawCheckpoint(store, { ...checkpoint("ITEMS"), identityAliases });
      await assert.rejects(store.load("run-1"), {
        name: "TypeError",
        message: "Checkpoint validation failed"
      });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
