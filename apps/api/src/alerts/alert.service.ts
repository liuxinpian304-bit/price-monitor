import { dedupKey } from "./alert-dedup.ts";

export interface AlertOffer {
  monitoredModelId: string;
  snapshotId: string;
  platformItemId: string;
  skuId: string;
  brand: string;
  standardModel: string;
  comparisonType: "BARE" | "BUNDLE";
  shopName: string;
  skuText: string;
  payableFen: number | null;
  url: string;
  capturedAt: Date;
  owner: string;
}

export interface AlertEvaluationDecision {
  category: "BARE" | "BUNDLE" | "REJECTED" | "MANUAL";
  comparable: boolean;
  bundleConfiguration: "SAME" | "DIFFERENT" | "UNKNOWN" | "NOT_APPLICABLE";
  reasons: string[];
}

export interface PriceAlertRecord {
  id: string;
  monitoredModelId: string;
  severity: "CONFIRMED_LOW" | "MANUAL_REVIEW";
  status: "PENDING" | "PRICE_CHANGED" | "NO_FOLLOW" | "FALSE_POSITIVE" | "WATCHING";
  dedupKey: string;
  brand: string;
  standardModel: string;
  comparisonType: "BARE" | "BUNDLE";
  owner: string;
  ownSnapshotId: string;
  competitorSnapshotId: string;
  ownShopName: string;
  ownSkuText: string;
  ownPriceFen: number;
  competitorShopName: string;
  competitorSkuText: string;
  competitorPriceFen: number;
  competitorItemId: string;
  competitorSkuId: string;
  competitorUrl: string;
  differenceFen: number;
  reasons: string[];
  firstSeenAt: Date;
  lastSeenAt: Date;
  notifiedAt: Date | null;
}

export interface AlertRepository {
  findByDedupKey(key: string): Promise<PriceAlertRecord | null>;
  create(input: Omit<PriceAlertRecord, "id" | "notifiedAt">): Promise<PriceAlertRecord>;
  markNotified(id: string, notifiedAt: Date): Promise<void>;
  recordNotificationFailure(alertId: string, message: string): Promise<void>;
}

export interface PriceAlertNotifier {
  sendPriceAlert(alert: PriceAlertRecord): Promise<void>;
}

function validMoney(value: number | null): value is number {
  return value !== null && Number.isSafeInteger(value) && value >= 0;
}

export class AlertService {
  private readonly repository: AlertRepository;
  private readonly notifier: PriceAlertNotifier;

  constructor(repository: AlertRepository, notifier: PriceAlertNotifier) {
    this.repository = repository;
    this.notifier = notifier;
  }

  async evaluate(
    ownOffer: AlertOffer,
    competitorOffer: AlertOffer,
    decision: AlertEvaluationDecision
  ): Promise<PriceAlertRecord | null> {
    if (!validMoney(ownOffer.payableFen) || !validMoney(competitorOffer.payableFen)) {
      return null;
    }
    if (competitorOffer.payableFen >= ownOffer.payableFen) {
      return null;
    }

    const severity = decision.comparable
      ? "CONFIRMED_LOW" as const
      : decision.category === "BUNDLE" && decision.bundleConfiguration === "DIFFERENT"
        ? "MANUAL_REVIEW" as const
        : null;
    if (severity === null) {
      return null;
    }

    const key = dedupKey(
      competitorOffer.platformItemId,
      competitorOffer.skuId,
      competitorOffer.payableFen
    );
    if (await this.repository.findByDedupKey(key)) {
      return null;
    }

    const alert = await this.repository.create({
      monitoredModelId: ownOffer.monitoredModelId,
      severity,
      status: "PENDING",
      dedupKey: key,
      brand: ownOffer.brand,
      standardModel: ownOffer.standardModel,
      comparisonType: ownOffer.comparisonType,
      owner: ownOffer.owner,
      ownSnapshotId: ownOffer.snapshotId,
      competitorSnapshotId: competitorOffer.snapshotId,
      ownShopName: ownOffer.shopName,
      ownSkuText: ownOffer.skuText,
      ownPriceFen: ownOffer.payableFen,
      competitorShopName: competitorOffer.shopName,
      competitorSkuText: competitorOffer.skuText,
      competitorPriceFen: competitorOffer.payableFen,
      competitorItemId: competitorOffer.platformItemId,
      competitorSkuId: competitorOffer.skuId,
      competitorUrl: competitorOffer.url,
      differenceFen: ownOffer.payableFen - competitorOffer.payableFen,
      reasons: decision.reasons,
      firstSeenAt: competitorOffer.capturedAt,
      lastSeenAt: competitorOffer.capturedAt
    });

    try {
      await this.notifier.sendPriceAlert(alert);
      const notifiedAt = new Date();
      await this.repository.markNotified(alert.id, notifiedAt);
      alert.notifiedAt = notifiedAt;
    } catch (error) {
      await this.repository.recordNotificationFailure(
        alert.id,
        error instanceof Error ? error.message : String(error)
      );
    }

    return alert;
  }
}
