import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";

import type { RunAlertSummary } from "../collection/run-alert.service.ts";
import { AuditService, type AuditEntryInput } from "../audit/audit.service.ts";
import { SecretStore } from "../settings/secret-store.ts";
import {
  RoleForbiddenError,
  SettingsService,
  type SettingRecord,
  type SettingsRepository
} from "../settings/settings.service.ts";
import {
  RunAlertNotificationApprovalService,
  RunAlertNotificationApprovalValidationError
} from "./run-alert-notification-approval.service.ts";
import {
  RunAlertNotifier,
  type ClaimedRunAlertBatch,
  type RunAlertNotificationRepository,
  type StoredRunAlertNotificationBatch
} from "./run-alert-notifier.ts";
import type { WecomMarkdownSender } from "./wecom/wecom.client.ts";

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
    shopCount: 12,
    searchLimit: 50,
    skuCount: 76,
    issueCount: 2,
    reviewCount: 3,
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
      alertId: `alert-${runId}`,
      severity: "CONFIRMED_LOW",
      snapshotId: `competitor-${runId}`,
      ownSnapshotId: "own-snapshot",
      ownSkuText: "MDR-7506 单机",
      ownPayableFen: 69_800,
      combinationSignature: "sku-combination-v1:fixture",
      combinationLabel: "Sony MDR-7506 单机",
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
  state: StoredRunAlertNotificationBatch["state"];
  token: string | null;
}

class MemoryBatchRepository implements RunAlertNotificationRepository {
  readonly batches = new Map<string, StoredBatch>();
  claimCount = 0;

  seed(input: RunAlertSummary): void {
    this.batches.set(input.runId, {
      id: `batch-${this.batches.size + 1}`,
      summary: structuredClone(input),
      state: "PENDING",
      token: null
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

  async claimBatch(runId: string): Promise<ClaimedRunAlertBatch | null> {
    this.claimCount += 1;
    const stored = this.batches.get(runId);
    if (!stored || stored.state !== "PENDING") return null;
    stored.state = "SENDING";
    stored.token = randomUUID();
    return {
      batchId: stored.id,
      attemptToken: stored.token,
      summary: structuredClone(stored.summary),
      alertIds: stored.summary.alerts.map((alert) => alert.alertId)
    };
  }

  async markBatchNotified(batch: ClaimedRunAlertBatch): Promise<void> {
    const stored = this.requireOwned(batch);
    stored.state = "NOTIFIED";
    stored.token = null;
  }

  async recordBatchNotificationFailure(batch: ClaimedRunAlertBatch): Promise<void> {
    const stored = this.requireOwned(batch);
    stored.state = "PENDING";
    stored.token = null;
  }

  async recordBatchNotificationAmbiguous(batch: ClaimedRunAlertBatch): Promise<void> {
    const stored = this.requireOwned(batch);
    stored.state = "AMBIGUOUS";
    stored.token = null;
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

class MemorySettingsRepository implements SettingsRepository {
  readonly records = new Map<string, SettingRecord>();
  async get(key: string) { return this.records.get(key) ?? null; }
  async set(record: SettingRecord) { this.records.set(record.key, structuredClone(record)); }
}

class MemoryAuditRepository {
  readonly entries: AuditEntryInput[] = [];
  async create(entry: AuditEntryInput) { this.entries.push(structuredClone(entry)); }
}

class RecordingSender implements WecomMarkdownSender {
  readonly messages: string[] = [];
  beforeSend: (() => Promise<void>) | null = null;

  async sendMarkdown(message: string): Promise<void> {
    if (this.beforeSend) await this.beforeSend();
    this.messages.push(message);
  }
}

function fixture() {
  const batches = new MemoryBatchRepository();
  const settingsRepository = new MemorySettingsRepository();
  const auditRepository = new MemoryAuditRepository();
  const settings = new SettingsService(
    settingsRepository,
    new SecretStore("test-only-master-key"),
    new AuditService(auditRepository),
    async () => undefined,
    () => new Date("2026-08-28T02:30:00.000Z")
  );
  const sender = new RecordingSender();
  const notifier = new RunAlertNotifier(
    batches,
    async () => sender,
    () => settings.isWecomLiveSendingApproved()
  );
  const approval = new RunAlertNotificationApprovalService(batches, settings, notifier);
  return { approval, auditRepository, batches, notifier, sender, settings, settingsRepository };
}

test("previews the current durable Markdown and digest without claiming or sending", async () => {
  const { approval, batches, sender } = fixture();
  batches.seed(summary());

  const preview = await approval.preview("run-1");

  assert.equal(preview.runId, "run-1");
  assert.equal(preview.state, "PENDING");
  assert.equal(preview.liveSendingApproved, false);
  assert.equal(
    preview.previewDigest,
    `sha256:${createHash("sha256").update(preview.markdown).digest("hex")}`
  );
  assert.match(preview.previewDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(batches.claimCount, 0);
  assert.equal(sender.messages.length, 0);
});

test("rejects wrong confirmation, stale digest, and non-admin approval before any claim", async () => {
  const { approval, batches, sender, settings } = fixture();
  batches.seed(summary());
  const preview = await approval.preview("run-1");

  await assert.rejects(
    () => approval.approve({
      runId: "run-1",
      previewDigest: preview.previewDigest,
      confirmation: "send_to_wecom"
    }, "admin-1", "ADMIN"),
    RunAlertNotificationApprovalValidationError
  );
  await assert.rejects(
    () => approval.approve({
      runId: "run-1",
      previewDigest: `sha256:${"0".repeat(64)}`,
      confirmation: "SEND_TO_WECOM"
    }, "admin-1", "ADMIN"),
    RunAlertNotificationApprovalValidationError
  );
  await assert.rejects(
    () => approval.approve({
      runId: "run-1",
      previewDigest: preview.previewDigest,
      confirmation: "SEND_TO_WECOM"
    }, "operator-1", "OPERATOR"),
    RoleForbiddenError
  );

  assert.equal(await settings.isWecomLiveSendingApproved(), false);
  assert.equal(batches.claimCount, 0);
  assert.equal(sender.messages.length, 0);
});

test("persists and audits approval before one exact send, then enables future batches", async () => {
  const {
    approval,
    auditRepository,
    batches,
    notifier,
    sender,
    settings,
    settingsRepository
  } = fixture();
  batches.seed(summary());
  const preview = await approval.preview("run-1");
  sender.beforeSend = async () => {
    assert.equal(await settings.isWecomLiveSendingApproved(), true);
    assert.equal(auditRepository.entries[0]?.action, "wecom.live-send.approved");
  };

  await approval.approve({
    runId: "run-1",
    previewDigest: preview.previewDigest,
    confirmation: "SEND_TO_WECOM"
  }, "admin-1", "ADMIN");

  assert.equal(await settings.isWecomLiveSendingApproved(), true);
  assert.equal(settingsRepository.records.get("WECOM_LIVE_SEND_APPROVAL")?.secret, false);
  assert.equal(sender.messages.length, 1);
  assert.equal(sender.messages[0], preview.markdown);
  assert.equal(batches.batches.get("run-1")?.state, "NOTIFIED");

  await approval.approve({
    runId: "run-1",
    previewDigest: preview.previewDigest,
    confirmation: "SEND_TO_WECOM"
  }, "admin-1", "ADMIN");
  assert.equal(sender.messages.length, 1);
  assert.equal(auditRepository.entries.length, 1);

  const next = summary("run-2");
  batches.seed(next);
  await notifier.send(next);
  assert.equal(sender.messages.length, 2);
  assert.equal(batches.batches.get("run-2")?.state, "NOTIFIED");
});
