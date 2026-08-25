import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import type { RunAlertSummary } from "../collection/run-alert.service.ts";
import type { WecomMarkdownSender } from "./wecom/wecom.client.ts";
import {
  RunAlertNotifier,
  type ClaimedRunAlertBatch,
  type RunAlertNotificationRepository
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
    searchLimit: 50,
    skuCount: 76,
    issueCount: 0,
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
    }]
  };
}

interface StoredBatch {
  id: string;
  summary: RunAlertSummary;
  state: "PENDING" | "SENDING" | "NOTIFIED";
  token: string | null;
  failures: string[];
}

class FakeBatchRepository implements RunAlertNotificationRepository {
  readonly batches = new Map<string, StoredBatch>();
  readonly notified: Array<{ alertIds: string[]; notifiedAt: Date }> = [];

  async claimBatch(input: RunAlertSummary, _attemptedAt: Date): Promise<ClaimedRunAlertBatch | null> {
    let stored = this.batches.get(input.runId);
    if (!stored) {
      if (input.alerts.length === 0 && input.systemIssue === null) return null;
      stored = {
        id: `batch-${this.batches.size + 1}`,
        summary: structuredClone(input),
        state: "PENDING",
        token: null,
        failures: []
      };
      this.batches.set(input.runId, stored);
    }
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
  const notifier = new RunAlertNotifier(repository, async () => sender);

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
  const notifier = new RunAlertNotifier(repository, async () => sender);
  const original = summary();

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

test("does not create a batch or message for an idempotent run with no new event", async () => {
  const repository = new FakeBatchRepository();
  const sender = new RecordingSender();
  const input = summary();
  input.alerts = [];
  const notifier = new RunAlertNotifier(repository, async () => sender);

  await notifier.send(input);

  assert.equal(sender.messages.length, 0);
  assert.equal(repository.batches.size, 0);
});

test("sends one baseline system summary even when the batch has no alert IDs", async () => {
  const repository = new FakeBatchRepository();
  const sender = new RecordingSender();
  const input = summary("run-system");
  input.alerts = [];
  input.baseline = null;
  input.systemIssue = "OWN_BASELINE_MISSING";
  const notifier = new RunAlertNotifier(repository, async () => sender);

  await notifier.send(input);

  assert.equal(sender.messages.length, 1);
  assert.match(sender.messages[0]!, /我方基准缺失/);
  assert.deepEqual(repository.notified[0]?.alertIds, []);
});

test("records a missing webhook without throwing or exposing configuration", async () => {
  const repository = new FakeBatchRepository();
  const notifier = new RunAlertNotifier(repository, async () => null);

  await notifier.send(summary());

  assert.deepEqual(repository.batches.get("run-1")?.failures, ["WECOM_NOT_CONFIGURED"]);
});
