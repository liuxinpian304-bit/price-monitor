import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
