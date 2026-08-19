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

  async create(entry: AuditEntryInput) {
    this.entries.push(entry);
  }
}

function createService() {
  const repository = new MemorySettingsRepository();
  const auditRepository = new MemoryAuditRepository();
  const secretStore = new SecretStore("test-only-master-key");
  const service = new SettingsService(
    repository,
    secretStore,
    new AuditService(auditRepository)
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
