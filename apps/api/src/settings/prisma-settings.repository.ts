import { Prisma, type PrismaClient } from "../../../../generated/prisma/client.ts";

import type { JsonValue } from "../audit/audit.service.ts";
import type { SettingRecord, SettingsRepository } from "./settings.service.ts";

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
    return {
      key: record.key,
      valueJson: (record.valueJson ?? null) as JsonValue,
      encryptedValue: record.encryptedValue ? Buffer.from(record.encryptedValue) : null,
      secret: record.secret,
      updatedBy: record.updatedBy
    };
  }

  async set(record: SettingRecord): Promise<void> {
    const data = {
      valueJson: record.valueJson === null ? Prisma.JsonNull : record.valueJson as Prisma.InputJsonValue,
      encryptedValue: record.encryptedValue ? Uint8Array.from(record.encryptedValue) : null,
      secret: record.secret,
      updatedBy: record.updatedBy
    };
    await this.prisma.systemSetting.upsert({
      where: { key: record.key },
      create: { key: record.key, ...data },
      update: data
    });
  }
}
