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
  priceConfidence: "CONFIRMED" | "ESTIMATED" | "MANUAL_REVIEW";
  stockState: "IN_STOCK" | "OUT_OF_STOCK" | "UNKNOWN";
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
  createIfAbsent(
    input: Omit<PriceAlertRecord, "id" | "notifiedAt">
  ): Promise<PriceAlertRecord | null>;
  markBatchNotified(ids: string[], notifiedAt: Date): Promise<void>;
  recordBatchNotificationFailure(ids: string[], message: string): Promise<void>;
}

function validMoney(value: number | null): value is number {
  return value !== null && Number.isSafeInteger(value) && value >= 0;
}

export class AlertService {
  private readonly repository: AlertRepository;

  constructor(repository: AlertRepository) {
    this.repository = repository;
  }

  async evaluate(
    ownOffer: AlertOffer,
    competitorOffer: AlertOffer,
    decision: AlertEvaluationDecision
  ): Promise<PriceAlertRecord | null> {
    if (
      ownOffer.monitoredModelId !== competitorOffer.monitoredModelId
      || ownOffer.priceConfidence !== "CONFIRMED"
      || competitorOffer.priceConfidence !== "CONFIRMED"
      || ownOffer.stockState !== "IN_STOCK"
      || competitorOffer.stockState !== "IN_STOCK"
    ) {
      return null;
    }
    if (!validMoney(ownOffer.payableFen) || !validMoney(competitorOffer.payableFen)) {
      return null;
    }
    if (competitorOffer.payableFen >= ownOffer.payableFen) {
      return null;
    }

    const severity = decision.comparable
      ? "CONFIRMED_LOW" as const
      : decision.category === "BUNDLE" && decision.bundleConfiguration !== "SAME"
        ? "MANUAL_REVIEW" as const
        : null;
    if (severity === null) {
      return null;
    }

    const key = dedupKey(
      ownOffer.monitoredModelId,
      ownOffer.skuId,
      competitorOffer.platformItemId,
      competitorOffer.skuId,
      competitorOffer.payableFen
    );
    return this.repository.createIfAbsent({
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
  }
}
