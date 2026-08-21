import { Prisma, type PrismaClient } from "../../../../generated/prisma/client.ts";

import type { AuditEntryInput, AuditRepository, JsonValue } from "./audit.service.ts";

function toJson(value: JsonValue): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

export class PrismaAuditRepository implements AuditRepository {
  private readonly prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  async create(entry: AuditEntryInput): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        actorId: entry.actorId,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        ...(entry.before === null ? {} : { before: toJson(entry.before) }),
        ...(entry.after === null ? {} : { after: toJson(entry.after) })
      }
    });
  }
}
