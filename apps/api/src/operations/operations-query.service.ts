import { Prisma, type PrismaClient } from "../../../../generated/prisma/client.ts";
import { CHECK_TIMES, TIME_ZONE } from "../../../../packages/config/src/schedule.ts";

const alertViewInclude = {
  monitoredModel: true,
  ownSnapshot: { include: { ownListing: true } },
  competitorSnapshot: { include: { searchCandidate: true } }
} satisfies Prisma.PriceAlertInclude;

type LoadedAlert = Prisma.PriceAlertGetPayload<{ include: typeof alertViewInclude }>;

const comparisonInclude = {
  ownListings: {
    where: { active: true },
    take: 1,
    include: { snapshots: { orderBy: { capturedAt: "desc" }, take: 1 } }
  },
  searchCandidates: {
    where: { comparable: true },
    include: { snapshots: { orderBy: { capturedAt: "desc" }, take: 1 } }
  }
} satisfies Prisma.MonitoredModelInclude;

type LoadedComparisonModel = Prisma.MonitoredModelGetPayload<{ include: typeof comparisonInclude }>;

function jsonReasons(value: Prisma.JsonValue | null): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function toAlertView(alert: LoadedAlert) {
  const own = alert.ownSnapshot;
  const competitor = alert.competitorSnapshot;
  return {
    id: alert.id,
    monitorCode: alert.monitoredModel.monitorCode,
    brand: alert.monitoredModel.brand,
    model: alert.monitoredModel.standardModel,
    type: alert.monitoredModel.comparisonType,
    sku: competitor?.skuText ?? own?.skuText ?? "未标注 SKU",
    ownSku: own?.skuText ?? "未标注 SKU",
    ownPriceFen: alert.ownPriceFen,
    ownShop: own?.shopName ?? "星空乐器专营店",
    competitorPriceFen: alert.competitorPriceFen,
    competitorShop: competitor?.shopName ?? "未知店铺",
    competitorUrl: competitor?.searchCandidate?.url ?? competitor?.evidenceUrl ?? "",
    differenceFen: alert.differenceFen,
    foundAt: alert.firstSeenAt.toISOString(),
    lastSeenAt: alert.lastSeenAt.toISOString(),
    status: alert.status,
    severity: alert.severity,
    owner: alert.monitoredModel.owner,
    reasons: jsonReasons(alert.reasons),
    notifiedAt: alert.notifiedAt?.toISOString() ?? null,
    notificationAttempts: alert.notificationAttempts,
    lastNotificationError: alert.lastNotificationError
  };
}

function currentShanghaiMinutes(now = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
  return hour * 60 + minute;
}

function scheduleRows(now = new Date()) {
  const current = currentShanghaiMinutes(now);
  return CHECK_TIMES.map((time) => {
    const [hour = 0, minute = 0] = time.split(":").map(Number);
    return { time, status: hour * 60 + minute <= current ? "DONE" : "WAITING" };
  });
}

function startOfRecentDay(now = new Date()): Date {
  return new Date(now.getTime() - 24 * 60 * 60 * 1000);
}

export class OperationsQueryService {
  private readonly prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  async listAlerts(type?: "BARE" | "BUNDLE") {
    const alerts = await this.prisma.priceAlert.findMany({
      ...(type ? { where: { monitoredModel: { comparisonType: type } } } : {}),
      include: alertViewInclude,
      orderBy: [{ status: "asc" }, { lastSeenAt: "desc" }]
    });
    return alerts.map(toAlertView);
  }

  async getAlert(id: string) {
    const alert = await this.prisma.priceAlert.findUnique({
      where: { id },
      include: alertViewInclude
    });
    return alert ? toAlertView(alert) : null;
  }

  async getDashboard() {
    const recent = startOfRecentDay();
    const [monitoredModels, lowEvents, pendingAlerts, failedRuns, latestAlerts] = await Promise.all([
      this.prisma.monitoredModel.count({ where: { enabled: true } }),
      this.prisma.priceAlert.count({ where: { firstSeenAt: { gte: recent } } }),
      this.prisma.priceAlert.count({ where: { status: "PENDING" } }),
      this.prisma.collectionRun.count({
        where: { createdAt: { gte: recent }, status: { in: ["FAILED", "PARTIAL_FAILED"] } }
      }),
      this.prisma.priceAlert.findMany({
        include: alertViewInclude,
        orderBy: { lastSeenAt: "desc" },
        take: 8
      })
    ]);
    const schedule = scheduleRows();
    return {
      stats: {
        scansToday: schedule.filter((item) => item.status === "DONE").length,
        plannedScans: CHECK_TIMES.length,
        monitoredModels,
        lowEvents,
        pendingAlerts,
        failedRuns
      },
      schedule,
      latestAlerts: latestAlerts.map(toAlertView),
      timeZone: TIME_ZONE
    };
  }

  async listComparisons(type: "BARE" | "BUNDLE") {
    const models = await this.prisma.monitoredModel.findMany({
      where: { enabled: true, comparisonType: type },
      include: comparisonInclude,
      orderBy: [{ brand: "asc" }, { standardModel: "asc" }]
    });
    return models.map((model) => this.toComparison(model)).filter((row) => row !== null);
  }

  async listManualCandidates() {
    const candidates = await this.prisma.searchCandidate.findMany({
      where: { decision: "MANUAL" },
      include: { monitoredModel: true, snapshots: { orderBy: { capturedAt: "desc" }, take: 1 } },
      orderBy: { lastSeenAt: "desc" },
      take: 200
    });
    return candidates.map((candidate) => ({
      id: candidate.id,
      model: `${candidate.monitoredModel.brand} ${candidate.monitoredModel.standardModel}`,
      title: candidate.title,
      sku: candidate.snapshots[0]?.skuText ?? "未标注 SKU",
      shop: candidate.shopName,
      reason: jsonReasons(candidate.reasons).join("；") || "系统无法确定商品类型或配置",
      foundAt: candidate.lastSeenAt.toISOString(),
      url: candidate.url
    }));
  }

  async listHistory(limit = 200) {
    const snapshots = await this.prisma.offerSnapshot.findMany({
      where: { payableFen: { not: null } },
      include: {
        collectionRun: { include: { monitoredModel: true } },
        searchCandidate: true,
        ownListing: true
      },
      orderBy: { capturedAt: "desc" },
      take: Math.min(Math.max(limit, 1), 500)
    });
    return snapshots.map((snapshot) => ({
      id: snapshot.id,
      model: `${snapshot.collectionRun.monitoredModel.brand} ${snapshot.collectionRun.monitoredModel.standardModel}`,
      type: snapshot.collectionRun.monitoredModel.comparisonType,
      sku: snapshot.skuText ?? "未标注 SKU",
      payableFen: snapshot.payableFen,
      shop: snapshot.shopName,
      stock: snapshot.stockState,
      capturedAt: snapshot.capturedAt.toISOString(),
      evidenceUrl: snapshot.searchCandidate?.url ?? snapshot.ownListing?.url ?? snapshot.evidenceUrl ?? ""
    }));
  }

  private toComparison(model: LoadedComparisonModel) {
    const own = model.ownListings[0]?.snapshots[0];
    const competitorSnapshots = model.searchCandidates
      .map((candidate) => ({ candidate, snapshot: candidate.snapshots[0] }))
      .filter((entry): entry is { candidate: typeof entry.candidate; snapshot: NonNullable<typeof entry.snapshot> } => Boolean(entry.snapshot?.payableFen))
      .sort((a, b) => (a.snapshot.payableFen ?? Number.MAX_SAFE_INTEGER) - (b.snapshot.payableFen ?? Number.MAX_SAFE_INTEGER));
    const lowest = competitorSnapshots[0];
    if (!own && !lowest) {
      return null;
    }
    return {
      id: model.id,
      monitorCode: model.monitorCode,
      model: `${model.brand} ${model.standardModel}`,
      sku: lowest?.snapshot.skuText ?? own?.skuText ?? "未标注 SKU",
      ownPriceFen: own?.payableFen ?? null,
      competitorPriceFen: lowest?.snapshot.payableFen ?? null,
      competitorShop: lowest?.snapshot.shopName ?? null,
      competitorUrl: lowest?.candidate.url ?? null,
      stock: lowest?.snapshot.stockState ?? "UNKNOWN",
      updatedAt: (lowest?.snapshot.capturedAt ?? own?.capturedAt ?? model.updatedAt).toISOString()
    };
  }
}
