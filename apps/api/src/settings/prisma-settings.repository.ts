import { Prisma, type PrismaClient } from "../../../../generated/prisma/client.ts";

import type { JsonValue } from "../audit/audit.service.ts";
import {
  wecomApprovalFrom,
  type AtomicWecomLiveSendApprovalInput,
  type SettingRecord,
  type SettingsRepository
} from "./settings.service.ts";

function settingRecordFromPrisma(record: {
  key: string;
  valueJson: Prisma.JsonValue | null;
  encryptedValue: Uint8Array | null;
  secret: boolean;
  updatedBy: string;
}): SettingRecord {
  return {
    key: record.key,
    valueJson: (record.valueJson ?? null) as JsonValue,
    encryptedValue: record.encryptedValue ? Buffer.from(record.encryptedValue) : null,
    secret: record.secret,
    updatedBy: record.updatedBy
  };
}

function settingData(record: SettingRecord) {
  return {
    valueJson: record.valueJson === null ? Prisma.JsonNull : record.valueJson as Prisma.InputJsonValue,
    encryptedValue: record.encryptedValue ? Uint8Array.from(record.encryptedValue) : null,
    secret: record.secret,
    updatedBy: record.updatedBy
  };
}

export class PrismaSettingsRepository implements SettingsRepository {
  private readonly prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  async get(key: string): Promise<SettingRecord | null> {
    const record = await this.prisma.systemSetting.findUnique({ where: { key } });
    if (!record) {
      return null;
    }
    return settingRecordFromPrisma(record);
  }

  async set(record: SettingRecord): Promise<void> {
    const data = settingData(record);
    await this.prisma.systemSetting.upsert({
      where: { key: record.key },
      create: { key: record.key, ...data },
      update: data
    });
  }

  async compareAndSetWecomLiveSendApproval(
    input: AtomicWecomLiveSendApprovalInput
  ): Promise<"APPROVED" | "ALREADY_APPROVED"> {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw(Prisma.sql`
        SELECT pg_advisory_xact_lock(hashtextextended(${input.setting.key}, 0))
      `);
      const existing = await transaction.systemSetting.findUnique({
        where: { key: input.setting.key }
      });
      if (existing && wecomApprovalFrom(settingRecordFromPrisma(existing))) {
        return "ALREADY_APPROVED";
      }

      const data = settingData(input.setting);
      await transaction.systemSetting.upsert({
        where: { key: input.setting.key },
        create: { key: input.setting.key, ...data },
        update: data
      });
      await transaction.auditLog.create({
        data: {
          actorId: input.audit.actorId,
          action: input.audit.action,
          entityType: input.audit.entityType,
          entityId: input.audit.entityId,
          ...(existing?.valueJson === null || existing?.valueJson === undefined
            ? {}
            : { before: existing.valueJson }),
          ...(input.setting.valueJson === null
            ? {}
            : { after: input.setting.valueJson as Prisma.InputJsonValue })
        }
      });
      return "APPROVED";
    }, { isolationLevel: "ReadCommitted", maxWait: 10_000, timeout: 30_000 });
  }
}
