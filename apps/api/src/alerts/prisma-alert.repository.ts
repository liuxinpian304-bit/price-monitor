import {
  Prisma,
  type PriceAlert,
  type PrismaClient
} from "../../../../generated/prisma/client.ts";

import type { AlertRepository, PriceAlertRecord } from "./alert.service.ts";

function reasonsFromJson(value: Prisma.JsonValue | null): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export class PrismaAlertRepository implements AlertRepository {
  private readonly prisma: PrismaClient | Prisma.TransactionClient;

  constructor(prisma: PrismaClient | Prisma.TransactionClient) {
    this.prisma = prisma;
  }

  async createIfAbsent(
    input: Omit<PriceAlertRecord, "id" | "notifiedAt">
  ): Promise<PriceAlertRecord | null> {
    const created = await this.prisma.priceAlert.createMany({
      data: [{
        monitoredModelId: input.monitoredModelId,
        ownSnapshotId: input.ownSnapshotId,
        competitorSnapshotId: input.competitorSnapshotId,
        severity: input.severity,
        status: input.status,
        dedupKey: input.dedupKey,
        ownPriceFen: input.ownPriceFen,
        competitorPriceFen: input.competitorPriceFen,
        differenceFen: input.differenceFen,
        reasons: input.reasons,
        firstSeenAt: input.firstSeenAt,
        lastSeenAt: input.lastSeenAt
      }],
      skipDuplicates: true
    });
    if (created.count === 0) return null;
    const alert = await this.prisma.priceAlert.findUniqueOrThrow({
      where: { dedupKey: input.dedupKey }
    });
    return this.toRecord(alert);
  }

  async markBatchNotified(ids: string[], notifiedAt: Date): Promise<void> {
    if (ids.length === 0) return;
    await this.prisma.priceAlert.updateMany({
      where: { id: { in: ids } },
      data: {
        notifiedAt,
        notificationAttempts: { increment: 1 },
        lastNotificationAttemptAt: notifiedAt,
        lastNotificationError: null
      }
    });
  }

  async recordBatchNotificationFailure(ids: string[], message: string): Promise<void> {
    if (ids.length === 0) return;
    await this.prisma.priceAlert.updateMany({
      where: { id: { in: ids } },
      data: {
        notificationAttempts: { increment: 1 },
        lastNotificationAttemptAt: new Date(),
        lastNotificationError: message
      }
    });
  }

  private async toRecord(alert: PriceAlert): Promise<PriceAlertRecord> {
    if (
      !alert.ownSnapshotId
      || !alert.competitorSnapshotId
      || alert.ownPriceFen === null
      || alert.competitorPriceFen === null
      || alert.differenceFen === null
      || alert.severity === "SYSTEM_ERROR"
    ) {
      throw new Error("Price alert is missing required persisted data");
    }
    const model = await this.prisma.monitoredModel.findUniqueOrThrow({
      where: { id: alert.monitoredModelId }
    });
    const own = await this.prisma.offerSnapshot.findUniqueOrThrow({
      where: { id: alert.ownSnapshotId }
    });
    const competitor = await this.prisma.offerSnapshot.findUniqueOrThrow({
      where: { id: alert.competitorSnapshotId }
    });
    const candidate = competitor.searchCandidateId
      ? await this.prisma.searchCandidate.findUnique({ where: { id: competitor.searchCandidateId } })
      : null;

    return {
      id: alert.id,
      monitoredModelId: alert.monitoredModelId,
      severity: alert.severity,
      status: alert.status,
      dedupKey: alert.dedupKey,
      brand: model.brand,
      standardModel: model.standardModel,
      comparisonType: model.comparisonType,
      owner: model.owner,
      ownSnapshotId: own.id,
      competitorSnapshotId: competitor.id,
      ownShopName: own.shopName,
      ownSkuText: own.skuText ?? "未标注SKU",
      ownPriceFen: alert.ownPriceFen,
      competitorShopName: competitor.shopName,
      competitorSkuText: competitor.skuText ?? "未标注SKU",
      competitorPriceFen: alert.competitorPriceFen,
      competitorItemId: competitor.platformItemId,
      competitorSkuId: competitor.skuId ?? "",
      competitorUrl: candidate?.url ?? competitor.evidenceUrl ?? "",
      differenceFen: alert.differenceFen,
      reasons: reasonsFromJson(alert.reasons),
      firstSeenAt: alert.firstSeenAt,
      lastSeenAt: alert.lastSeenAt,
      notifiedAt: alert.notifiedAt
    };
  }
}
