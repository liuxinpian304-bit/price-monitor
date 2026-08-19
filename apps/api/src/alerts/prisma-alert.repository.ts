import { Prisma, type PrismaClient } from "../../../../generated/prisma/client.ts";

import type { AlertRepository, PriceAlertRecord } from "./alert.service.ts";

const alertInclude = {
  monitoredModel: true,
  ownSnapshot: { include: { ownListing: true } },
  competitorSnapshot: { include: { searchCandidate: true } }
} satisfies Prisma.PriceAlertInclude;

type LoadedAlert = Prisma.PriceAlertGetPayload<{ include: typeof alertInclude }>;

function reasonsFromJson(value: Prisma.JsonValue | null): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function toRecord(alert: LoadedAlert): PriceAlertRecord {
  const own = alert.ownSnapshot;
  const competitor = alert.competitorSnapshot;
  if (
    !own ||
    !competitor ||
    alert.ownPriceFen === null ||
    alert.competitorPriceFen === null ||
    alert.differenceFen === null
  ) {
    throw new Error(`Price alert ${alert.id} is missing required snapshot or price data`);
  }

  return {
    id: alert.id,
    monitoredModelId: alert.monitoredModelId,
    severity: alert.severity === "MANUAL_REVIEW" ? "MANUAL_REVIEW" : "CONFIRMED_LOW",
    status: alert.status,
    dedupKey: alert.dedupKey,
    brand: alert.monitoredModel.brand,
    standardModel: alert.monitoredModel.standardModel,
    comparisonType: alert.monitoredModel.comparisonType,
    owner: alert.monitoredModel.owner,
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
    competitorUrl: competitor.searchCandidate?.url ?? competitor.evidenceUrl ?? "",
    differenceFen: alert.differenceFen,
    reasons: reasonsFromJson(alert.reasons),
    firstSeenAt: alert.firstSeenAt,
    lastSeenAt: alert.lastSeenAt,
    notifiedAt: alert.notifiedAt
  };
}

export class PrismaAlertRepository implements AlertRepository {
  private readonly prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  async findByDedupKey(key: string): Promise<PriceAlertRecord | null> {
    const alert = await this.prisma.priceAlert.findUnique({
      where: { dedupKey: key },
      include: alertInclude
    });
    return alert ? toRecord(alert) : null;
  }

  async create(
    input: Omit<PriceAlertRecord, "id" | "notifiedAt">
  ): Promise<PriceAlertRecord> {
    const created = await this.prisma.priceAlert.create({
      data: {
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
      },
      select: { id: true }
    });
    const alert = await this.prisma.priceAlert.findUniqueOrThrow({
      where: { id: created.id },
      include: alertInclude
    });
    return toRecord(alert);
  }

  async markNotified(id: string, notifiedAt: Date): Promise<void> {
    await this.prisma.priceAlert.update({
      where: { id },
      data: {
        notifiedAt,
        notificationAttempts: { increment: 1 },
        lastNotificationAttemptAt: notifiedAt,
        lastNotificationError: null
      }
    });
  }

  async recordNotificationFailure(alertId: string, message: string): Promise<void> {
    await this.prisma.priceAlert.update({
      where: { id: alertId },
      data: {
        notificationAttempts: { increment: 1 },
        lastNotificationAttemptAt: new Date(),
        lastNotificationError: message
      }
    });
  }
}
