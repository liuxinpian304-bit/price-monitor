import { CHECK_TIMES, TIME_ZONE } from "../../../../packages/config/src/schedule.ts";
import { AuditService, type JsonValue } from "../audit/audit.service.ts";
import { SecretStore } from "./secret-store.ts";

export type UserRole = "ADMIN" | "OPERATOR";
export type SecretSettingKey = "WECOM_WEBHOOK" | "COMMERCE_API_KEY";

export interface SettingRecord {
  key: string;
  valueJson: JsonValue | null;
  encryptedValue: Buffer | null;
  secret: boolean;
  updatedBy: string;
}

export interface SettingsRepository {
  get(key: string): Promise<SettingRecord | null>;
  set(record: SettingRecord): Promise<void>;
}

export interface ScheduleInput {
  enabled: boolean;
  checkTimes: string[];
}

export interface PublicSettings {
  shopName: string;
  provider: "manual" | "external" | "desktop";
  schedulerEnabled: boolean;
  checkTimes: string[];
  timeZone: typeof TIME_ZONE;
  wecomWebhookConfigured: boolean;
  commerceApiKeyConfigured: boolean;
}

export class RoleForbiddenError extends Error {}
export class SettingsValidationError extends Error {}

const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const WECOM_LIVE_SEND_APPROVAL = "WECOM_LIVE_SEND_APPROVAL";
const PREVIEW_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

function requireAdmin(role: UserRole): void {
  if (role !== "ADMIN") {
    throw new RoleForbiddenError("只有管理员可以修改系统配置");
  }
}

function scheduleFrom(record: SettingRecord | null): ScheduleInput {
  if (!record || typeof record.valueJson !== "object" || record.valueJson === null || Array.isArray(record.valueJson)) {
    return { enabled: true, checkTimes: [...CHECK_TIMES] };
  }
  const raw = record.valueJson as { enabled?: unknown; checkTimes?: unknown };
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : true,
    checkTimes: Array.isArray(raw.checkTimes) && raw.checkTimes.every((value) => typeof value === "string")
      ? raw.checkTimes
      : [...CHECK_TIMES]
  };
}

interface WecomLiveSendApproval {
  approved: true;
  actorId: string;
  approvedAt: string;
  previewRunId: string;
  previewDigest: string;
}

function wecomApprovalFrom(record: SettingRecord | null): WecomLiveSendApproval | null {
  if (!record || record.secret || record.encryptedValue !== null) return null;
  if (typeof record.valueJson !== "object" || record.valueJson === null || Array.isArray(record.valueJson)) {
    return null;
  }
  const value = record.valueJson as Record<string, unknown>;
  if (
    value.approved !== true
    || typeof value.actorId !== "string"
    || value.actorId.trim() === ""
    || typeof value.approvedAt !== "string"
    || !Number.isFinite(Date.parse(value.approvedAt))
    || typeof value.previewRunId !== "string"
    || value.previewRunId.trim() === ""
    || typeof value.previewDigest !== "string"
    || !PREVIEW_DIGEST_PATTERN.test(value.previewDigest)
  ) return null;
  return {
    approved: true,
    actorId: value.actorId,
    approvedAt: value.approvedAt,
    previewRunId: value.previewRunId,
    previewDigest: value.previewDigest
  };
}

export class SettingsService {
  private readonly repository: SettingsRepository;
  private readonly secretStore: SecretStore;
  private readonly audit: AuditService;
  private readonly onScheduleSettingsChanged: () => Promise<void>;
  private readonly now: () => Date;

  constructor(
    repository: SettingsRepository,
    secretStore: SecretStore,
    audit: AuditService,
    onScheduleSettingsChanged: () => Promise<void> = async () => undefined,
    now: () => Date = () => new Date()
  ) {
    this.repository = repository;
    this.secretStore = secretStore;
    this.audit = audit;
    this.onScheduleSettingsChanged = onScheduleSettingsChanged;
    this.now = now;
  }

  async getPublicSettings(_role: UserRole): Promise<PublicSettings> {
    const [scheduleRecord, webhook, commerceKey, providerRecord] = await Promise.all([
      this.repository.get("SCHEDULE"),
      this.repository.get("WECOM_WEBHOOK"),
      this.repository.get("COMMERCE_API_KEY"),
      this.repository.get("COMMERCE_PROVIDER")
    ]);
    const schedule = scheduleFrom(scheduleRecord);
    const provider = providerRecord?.valueJson === "external" || providerRecord?.valueJson === "desktop"
      ? providerRecord.valueJson
      : "manual";

    return {
      shopName: "星空乐器专营店",
      provider,
      schedulerEnabled: schedule.enabled,
      checkTimes: schedule.checkTimes,
      timeZone: TIME_ZONE,
      wecomWebhookConfigured: Boolean(webhook?.encryptedValue),
      commerceApiKeyConfigured: Boolean(commerceKey?.encryptedValue)
    };
  }

  async updateSchedule(input: ScheduleInput, actorId: string, role: UserRole): Promise<void> {
    requireAdmin(role);
    const times = [...new Set(input.checkTimes)];
    if (times.length === 0 || times.length > 24 || times.some((time) => !TIME_PATTERN.test(time))) {
      throw new SettingsValidationError("检查时间必须是有效且不重复的 HH:mm 列表");
    }

    const before = await this.repository.get("SCHEDULE");
    const valueJson: JsonValue = { enabled: input.enabled, checkTimes: times };
    await this.repository.set({
      key: "SCHEDULE",
      valueJson,
      encryptedValue: null,
      secret: false,
      updatedBy: actorId
    });
    await this.audit.record({
      actorId,
      action: "settings.schedule.updated",
      entityType: "SystemSetting",
      entityId: "SCHEDULE",
      before: before?.valueJson ?? null,
      after: valueJson
    });
    await this.onScheduleSettingsChanged();
  }

  async updateProvider(provider: "manual" | "external" | "desktop", actorId: string, role: UserRole): Promise<void> {
    requireAdmin(role);
    const before = await this.repository.get("COMMERCE_PROVIDER");
    await this.repository.set({
      key: "COMMERCE_PROVIDER",
      valueJson: provider,
      encryptedValue: null,
      secret: false,
      updatedBy: actorId
    });
    await this.audit.record({
      actorId,
      action: "settings.provider.updated",
      entityType: "SystemSetting",
      entityId: "COMMERCE_PROVIDER",
      before: before?.valueJson ?? null,
      after: provider
    });
    await this.onScheduleSettingsChanged();
  }

  async updateSecret(key: SecretSettingKey, plaintext: string, actorId: string, role: UserRole): Promise<void> {
    requireAdmin(role);
    const encryptedValue = this.secretStore.encrypt(plaintext);
    const before = await this.repository.get(key);
    await this.repository.set({
      key,
      valueJson: null,
      encryptedValue,
      secret: true,
      updatedBy: actorId
    });
    await this.audit.record({
      actorId,
      action: "settings.secret.updated",
      entityType: "SystemSetting",
      entityId: key,
      before: { configured: Boolean(before?.encryptedValue) },
      after: { configured: true }
    });
  }

  async readSecretForInternalUse(key: SecretSettingKey): Promise<string | null> {
    const record = await this.repository.get(key);
    return record?.encryptedValue ? this.secretStore.decrypt(record.encryptedValue) : null;
  }

  async isWecomLiveSendingApproved(): Promise<boolean> {
    return wecomApprovalFrom(await this.repository.get(WECOM_LIVE_SEND_APPROVAL)) !== null;
  }

  async approveWecomLiveSending(
    input: { previewRunId: string; previewDigest: string },
    actorId: string,
    role: UserRole
  ): Promise<void> {
    requireAdmin(role);
    if (actorId.trim() === "") throw new TypeError("actorId is required");
    if (input.previewRunId.trim() === "" || !PREVIEW_DIGEST_PATTERN.test(input.previewDigest)) {
      throw new SettingsValidationError("企业微信预览确认信息无效");
    }

    const before = await this.repository.get(WECOM_LIVE_SEND_APPROVAL);
    if (wecomApprovalFrom(before)) return;
    const approvalMetadata = {
      actorId,
      approvedAt: this.now().toISOString(),
      previewRunId: input.previewRunId,
      previewDigest: input.previewDigest
    };
    const valueJson: JsonValue = {
      approved: true,
      ...approvalMetadata
    };
    await this.repository.set({
      key: WECOM_LIVE_SEND_APPROVAL,
      valueJson: { approved: false, ...approvalMetadata },
      encryptedValue: null,
      secret: false,
      updatedBy: actorId
    });
    await this.audit.record({
      actorId,
      action: "wecom.live-send.approved",
      entityType: "SystemSetting",
      entityId: WECOM_LIVE_SEND_APPROVAL,
      before: before?.valueJson ?? null,
      after: valueJson
    });
    await this.repository.set({
      key: WECOM_LIVE_SEND_APPROVAL,
      valueJson,
      encryptedValue: null,
      secret: false,
      updatedBy: actorId
    });
  }
}
