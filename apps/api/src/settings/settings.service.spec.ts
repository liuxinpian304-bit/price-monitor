import assert from "node:assert/strict";
import test from "node:test";

import { CHECK_TIMES, TIME_ZONE } from "../../../../packages/config/src/schedule.ts";
import { AuditService, type AuditEntryInput } from "../audit/audit.service.ts";
import {
  RoleForbiddenError,
  SettingsService,
  type SettingRecord,
  type SettingsRepository
} from "./settings.service.ts";
import { SecretStore } from "./secret-store.ts";

class MemorySettingsRepository implements SettingsRepository {
  readonly records = new Map<string, SettingRecord>();

  async get(key: string) {
    return this.records.get(key) ?? null;
  }

  async set(record: SettingRecord) {
    this.records.set(record.key, record);
  }
}

class MemoryAuditRepository {
  readonly entries: AuditEntryInput[] = [];
  failure: Error | null = null;

  async create(entry: AuditEntryInput) {
    if (this.failure) throw this.failure;
    this.entries.push(entry);
  }
}

function createService(
  onScheduleSettingsChanged?: () => Promise<void>,
  now: () => Date = () => new Date("2026-08-28T02:30:00.000Z")
) {
  const repository = new MemorySettingsRepository();
  const auditRepository = new MemoryAuditRepository();
  const secretStore = new SecretStore("test-only-master-key");
  const service = new SettingsService(
    repository,
    secretStore,
    new AuditService(auditRepository),
    onScheduleSettingsChanged,
    now
  );
  return { service, repository, auditRepository, secretStore };
}

test("secret store encrypts authenticated bytes without retaining plaintext", () => {
  const store = new SecretStore("test-only-master-key");
  const encrypted = store.encrypt("https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=secret");

  assert.equal(encrypted.includes(Buffer.from("secret")), false);
  assert.equal(
    store.decrypt(encrypted),
    "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=secret"
  );
});

test("operator can see whether secrets are configured but never sees their plaintext", async () => {
  const { service } = createService();
  await service.updateSecret("WECOM_WEBHOOK", "https://example.test/hook-secret", "admin-1", "ADMIN");

  const settings = await service.getPublicSettings("OPERATOR");

  assert.equal(settings.wecomWebhookConfigured, true);
  assert.equal(JSON.stringify(settings).includes("hook-secret"), false);
  assert.deepEqual(settings.checkTimes, CHECK_TIMES);
  assert.equal(settings.timeZone, TIME_ZONE);
});

test("operator cannot modify the system schedule", async () => {
  const { service } = createService();

  await assert.rejects(
    () => service.updateSchedule({ enabled: false, checkTimes: ["09:30"] }, "operator-1", "OPERATOR"),
    RoleForbiddenError
  );
});

test("admin schedule changes are validated, stored and audited without secrets", async () => {
  const { service, auditRepository } = createService();

  await service.updateSchedule(
    { enabled: true, checkTimes: [...CHECK_TIMES] },
    "admin-1",
    "ADMIN"
  );

  assert.equal(auditRepository.entries.length, 1);
  assert.equal(auditRepository.entries[0]?.action, "settings.schedule.updated");
  assert.equal(JSON.stringify(auditRepository.entries).includes("secret"), false);
});

test("desktop is a selectable provider while fresh settings remain manual", async () => {
  const { service } = createService();

  assert.equal((await service.getPublicSettings("ADMIN")).provider, "manual");
  await service.updateProvider("desktop", "admin-1", "ADMIN");
  assert.equal((await service.getPublicSettings("ADMIN")).provider, "desktop");
});

test("schedule and provider mutations immediately reconcile persisted clock schedules", async () => {
  let reconciliations = 0;
  const { service } = createService(async () => { reconciliations += 1; });

  await service.updateSchedule({ enabled: false, checkTimes: [...CHECK_TIMES] }, "admin-1", "ADMIN");
  await service.updateProvider("manual", "admin-1", "ADMIN");

  assert.equal(reconciliations, 2);
});

test("defaults WeCom live sending to denied and persists one audited admin approval", async () => {
  const { service, repository, auditRepository } = createService();
  const previewDigest = `sha256:${"a".repeat(64)}`;

  assert.equal(await service.isWecomLiveSendingApproved(), false);
  await assert.rejects(
    () => service.approveWecomLiveSending(
      { previewRunId: "run-1", previewDigest },
      "operator-1",
      "OPERATOR"
    ),
    RoleForbiddenError
  );

  await service.approveWecomLiveSending(
    { previewRunId: "run-1", previewDigest },
    "admin-1",
    "ADMIN"
  );
  await service.approveWecomLiveSending(
    { previewRunId: "run-2", previewDigest: `sha256:${"b".repeat(64)}` },
    "admin-2",
    "ADMIN"
  );

  assert.equal(await service.isWecomLiveSendingApproved(), true);
  assert.deepEqual(repository.records.get("WECOM_LIVE_SEND_APPROVAL"), {
    key: "WECOM_LIVE_SEND_APPROVAL",
    valueJson: {
      approved: true,
      actorId: "admin-1",
      approvedAt: "2026-08-28T02:30:00.000Z",
      previewRunId: "run-1",
      previewDigest
    },
    encryptedValue: null,
    secret: false,
    updatedBy: "admin-1"
  });
  assert.equal(auditRepository.entries.length, 1);
  assert.deepEqual(auditRepository.entries[0], {
    actorId: "admin-1",
    action: "wecom.live-send.approved",
    entityType: "SystemSetting",
    entityId: "WECOM_LIVE_SEND_APPROVAL",
    before: null,
    after: {
      approved: true,
      actorId: "admin-1",
      approvedAt: "2026-08-28T02:30:00.000Z",
      previewRunId: "run-1",
      previewDigest
    }
  });
});

test("keeps WeCom live sending denied when the approval audit cannot be recorded", async () => {
  const { service, repository, auditRepository } = createService();
  auditRepository.failure = new Error("audit unavailable");

  await assert.rejects(
    () => service.approveWecomLiveSending(
      { previewRunId: "run-1", previewDigest: `sha256:${"a".repeat(64)}` },
      "admin-1",
      "ADMIN"
    ),
    /audit unavailable/
  );

  assert.equal(await service.isWecomLiveSendingApproved(), false);
  assert.equal(repository.records.get("WECOM_LIVE_SEND_APPROVAL")?.secret, false);
  assert.equal(auditRepository.entries.length, 0);
});
