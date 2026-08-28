import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import type { RunAlertSummary } from "../collection/run-alert.service.ts";
import type { WecomMarkdownSender } from "./wecom/wecom.client.ts";
import { WecomDeliveryAmbiguousError } from "./wecom/wecom.client.ts";
import {
  RunAlertNotifier,
  type ClaimedRunAlertBatch,
  type RunAlertNotificationRepository,
  type StoredRunAlertNotificationBatch
} from "./run-alert-notifier.ts";

function summary(runId = "run-1"): RunAlertSummary {
  return {
    runId,
    monitoredModelId: "model-1",
    brand: "Sony",
    standardModel: "MDR-7506",
    comparisonType: "BARE",
    owner: "张三",
    completedAt: new Date("2026-08-25T01:31:00.000Z"),
    checkedItemCount: 50,
    positionCount: 50,
    shopCount: 1,
    searchLimit: 50,
    skuCount: 76,
    issueCount: 0,
    reviewCount: 0,
    reportUrl: `https://monitor.example.test/collection-runs/${runId}`,
    baseline: {
      snapshotId: "own-snapshot",
      skuId: "own-sku",
      skuText: "MDR-7506 单机",
      activityPriceFen: 69_800,
      publicDiscountFen: 0,
      payableFen: 69_800
    },
    systemIssue: null,
    alerts: [{
      alertId: "alert-1",
      severity: "CONFIRMED_LOW",
      snapshotId: "competitor-snapshot",
      ownSnapshotId: "own-snapshot",
      ownSkuText: "MDR-7506 单机",
      ownPayableFen: 69_800,
      combinationSignature: "sku-combination-v1:fixture",
      combinationLabel: "Sony MDR-7506 新品 核心耳机MDR-7506x1",
      rank: 1,
      shopName: "同行店铺",
      title: "Sony MDR-7506",
      skuText: "MDR-7506 单机",
      activityPriceFen: 69_799,
      publicDiscountFen: 0,
      payableFen: 69_799,
      differenceFen: 1,
      url: "https://item.taobao.com/item.htm?id=1",
      reasons: ["同配置裸机"]
    }],
    missingOwnGroups: []
  };
}

interface StoredBatch {
  id: string;
  summary: RunAlertSummary;
  state: "PENDING" | "SENDING" | "NOTIFIED" | "AMBIGUOUS";
  token: string | null;
  failures: string[];
}

class FakeBatchRepository implements RunAlertNotificationRepository {
  readonly batches = new Map<string, StoredBatch>();
  readonly notified: Array<{ alertIds: string[]; notifiedAt: Date }> = [];
  claimCount = 0;

  seed(input: RunAlertSummary): void {
    this.batches.set(input.runId, {
      id: `batch-${this.batches.size + 1}`,
      summary: structuredClone(input),
      state: "PENDING",
      token: null,
      failures: []
    });
  }

  async getBatch(runId: string): Promise<StoredRunAlertNotificationBatch | null> {
    const stored = this.batches.get(runId);
    return stored ? {
      batchId: stored.id,
      runId,
      state: stored.state,
      summary: structuredClone(stored.summary)
    } : null;
  }

  async claimBatch(runId: string, _attemptedAt: Date): Promise<ClaimedRunAlertBatch | null> {
    this.claimCount += 1;
    const stored = this.batches.get(runId);
    if (!stored) return null;
    if (stored.state !== "PENDING") return null;
    stored.state = "SENDING";
    stored.token = randomUUID();
    return {
      batchId: stored.id,
      attemptToken: stored.token,
      summary: structuredClone(stored.summary),
      alertIds: stored.summary.alerts.map((alert) => alert.alertId)
    };
  }

  async markBatchNotified(batch: ClaimedRunAlertBatch, notifiedAt: Date) {
    const stored = this.requireOwned(batch);
    stored.state = "NOTIFIED";
    stored.token = null;
    this.notified.push({ alertIds: [...batch.alertIds], notifiedAt });
  }

  async recordBatchNotificationFailure(
    batch: ClaimedRunAlertBatch,
    message: string,
    _failedAt: Date
  ) {
    const stored = this.requireOwned(batch);
    stored.state = "PENDING";
    stored.token = null;
    stored.failures.push(message);
  }

  async recordBatchNotificationAmbiguous(batch: ClaimedRunAlertBatch, _failedAt: Date) {
    const stored = this.requireOwned(batch);
    stored.state = "AMBIGUOUS";
    stored.token = null;
    stored.failures.push("WECOM_DELIVERY_AMBIGUOUS");
  }

  async listRetryableSummaries(): Promise<RunAlertSummary[]> {
    return [...this.batches.values()]
      .filter((batch) => batch.state === "PENDING")
      .map((batch) => structuredClone(batch.summary));
  }

  private requireOwned(batch: ClaimedRunAlertBatch): StoredBatch {
    const stored = [...this.batches.values()].find((item) => item.id === batch.batchId);
    assert.ok(stored);
    assert.equal(stored.state, "SENDING");
    assert.equal(stored.token, batch.attemptToken);
    return stored;
  }
}

class RecordingSender implements WecomMarkdownSender {
  readonly messages: string[] = [];
  failure: Error | null = null;

  async sendMarkdown(message: string) {
    this.messages.push(message);
    if (this.failure) throw this.failure;
  }
}

test("sends and marks every new run alert in one logical batch", async () => {
  const repository = new FakeBatchRepository();
  const sender = new RecordingSender();
  const input = summary();
  input.alerts.push({ ...input.alerts[0]!, alertId: "alert-2", snapshotId: "snapshot-2" });
  repository.seed(input);
  const notifier = new RunAlertNotifier(repository, async () => sender, async () => true);

  await notifier.send(input);

  assert.equal(sender.messages.length, 1);
  assert.deepEqual(repository.notified[0]?.alertIds, ["alert-1", "alert-2"]);
  assert.equal(repository.batches.get("run-1")?.state, "NOTIFIED");
});
test("keeps a failed batch and retries the exact original logical summary once", async () => {
  const repository = new FakeBatchRepository();
  const sender = new RecordingSender();
  sender.failure = new Error(
    "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=secret body=private"
  );
  const original = summary();
  repository.seed(original);
  const notifier = new RunAlertNotifier(repository, async () => sender, async () => true);

  await notifier.send(original);

  const stored = repository.batches.get("run-1")!;
  assert.equal(stored.state, "PENDING");
  assert.deepEqual(stored.failures, ["WECOM_DELIVERY_FAILED"]);
  assert.equal(stored.failures[0]?.includes("secret"), false);

  sender.failure = null;
  const repeatedEvaluation = { ...summary(), alerts: [], brand: "Changed after failure" };
  await notifier.send(repeatedEvaluation);
  await notifier.send(repeatedEvaluation);

  assert.equal(sender.messages.length, 2);
  assert.equal(sender.messages[0], sender.messages[1]);
  assert.equal(repository.batches.get("run-1")?.state, "NOTIFIED");
  assert.equal(repository.notified.length, 1);
});

test("never constructs a notification batch after evaluation", async () => {
  const repository = new FakeBatchRepository();
  const sender = new RecordingSender();
  const notifier = new RunAlertNotifier(repository, async () => sender, async () => true);

  await notifier.send(summary("missing-outbox"));

  assert.equal(repository.batches.size, 0);
  assert.equal(sender.messages.length, 0);
});

test("sends one baseline system summary even when the batch has no alert IDs", async () => {
  const repository = new FakeBatchRepository();
  const sender = new RecordingSender();
  const input = summary("run-system");
  input.alerts = [];
  input.baseline = null;
  input.systemIssue = "OWN_BASELINE_MISSING";
  repository.seed(input);
  const notifier = new RunAlertNotifier(repository, async () => sender, async () => true);

  await notifier.send(input);

  assert.equal(sender.messages.length, 1);
  assert.match(sender.messages[0]!, /我方基准缺失/);
  assert.deepEqual(repository.notified[0]?.alertIds, []);
});

test("records a missing webhook without throwing or exposing configuration", async () => {
  const repository = new FakeBatchRepository();
  const input = summary();
  repository.seed(input);
  const notifier = new RunAlertNotifier(repository, async () => null, async () => true);

  await notifier.send(input);

  assert.deepEqual(repository.batches.get("run-1")?.failures, ["WECOM_NOT_CONFIGURED"]);
});

test("records ambiguous delivery and never claims the batch for another POST", async () => {
  const repository = new FakeBatchRepository();
  const sender = new RecordingSender();
  sender.failure = new WecomDeliveryAmbiguousError();
  const input = summary();
  repository.seed(input);
  const notifier = new RunAlertNotifier(repository, async () => sender, async () => true);

  await notifier.send(input);
  await notifier.send(input);

  assert.equal(sender.messages.length, 1);
  assert.equal(repository.batches.get("run-1")?.state, "AMBIGUOUS");
  assert.deepEqual(repository.batches.get("run-1")?.failures, ["WECOM_DELIVERY_AMBIGUOUS"]);
});

test("returns before claiming a durable batch while live sending is unapproved", async () => {
  const repository = new FakeBatchRepository();
  const sender = new RecordingSender();
  const input = summary("run-unapproved");
  repository.seed(input);
  const notifier = new RunAlertNotifier(repository, async () => sender, async () => false);

  await notifier.send(input);

  assert.equal(repository.claimCount, 0);
  assert.equal(repository.batches.get("run-unapproved")?.state, "PENDING");
  assert.equal(sender.messages.length, 0);
});
