import assert from "node:assert/strict";
import test from "node:test";

import {
  AlertService,
  type AlertEvaluationDecision,
  type AlertOffer,
  type AlertRepository,
  type PriceAlertRecord,
  type PriceAlertNotifier
} from "./alert.service.ts";

function ownOffer(priceFen = 630_000): AlertOffer {
  return {
    monitoredModelId: "model-1",
    snapshotId: "own-snapshot-1",
    platformItemId: "own-1001",
    skuId: "own-sku",
    brand: "RME",
    standardModel: "Babyface Pro FS",
    comparisonType: "BARE",
    shopName: "星空乐器专营店",
    skuText: "Babyface Pro FS单机",
    payableFen: priceFen,
    url: "https://detail.tmall.com/item.htm?id=own-1001",
    capturedAt: new Date("2026-08-19T01:30:00.000Z"),
    owner: "张三"
  };
}

function competitorOffer(priceFen = 629_999): AlertOffer {
  return {
    monitoredModelId: "model-1",
    snapshotId: "competitor-snapshot-1",
    platformItemId: "competitor-1001",
    skuId: "competitor-sku",
    brand: "RME",
    standardModel: "Babyface Pro FS",
    comparisonType: "BARE",
    shopName: "同行专业音频店",
    skuText: "Babyface Pro FS单机",
    payableFen: priceFen,
    url: "https://detail.tmall.com/item.htm?id=competitor-1001",
    capturedAt: new Date("2026-08-19T01:30:05.000Z"),
    owner: "张三"
  };
}

const comparable: AlertEvaluationDecision = {
  category: "BARE",
  comparable: true,
  bundleConfiguration: "NOT_APPLICABLE",
  reasons: ["同品牌、同型号、同版本裸机"]
};

class FakeAlertRepository implements AlertRepository {
  alerts: PriceAlertRecord[] = [];
  notificationFailures: Array<{ alertId: string; message: string }> = [];

  async findByDedupKey(key: string) {
    return this.alerts.find((alert) => alert.dedupKey === key) ?? null;
  }

  async create(input: Omit<PriceAlertRecord, "id" | "notifiedAt">) {
    const alert = { ...input, id: `alert-${this.alerts.length + 1}`, notifiedAt: null };
    this.alerts.push(alert);
    return alert;
  }

  async markNotified(id: string, notifiedAt: Date) {
    const alert = this.alerts.find((item) => item.id === id)!;
    alert.notifiedAt = notifiedAt;
  }

  async recordNotificationFailure(alertId: string, message: string) {
    this.notificationFailures.push({ alertId, message });
  }
}

class FakeNotifier implements PriceAlertNotifier {
  sent: PriceAlertRecord[] = [];
  error: Error | null = null;

  async sendPriceAlert(alert: PriceAlertRecord) {
    if (this.error) throw this.error;
    this.sent.push(alert);
  }
}

function context() {
  const repository = new FakeAlertRepository();
  const notifier = new FakeNotifier();
  return { repository, notifier, service: new AlertService(repository, notifier) };
}

test("creates and sends an alert when the competitor is lower by one fen", async () => {
  const { service, repository, notifier } = context();

  const alert = await service.evaluate(ownOffer(), competitorOffer(), comparable);

  assert.equal(alert?.severity, "CONFIRMED_LOW");
  assert.equal(alert?.differenceFen, 1);
  assert.equal(repository.alerts.length, 1);
  assert.equal(notifier.sent.length, 1);
  assert.notEqual(repository.alerts[0]?.notifiedAt, null);
});

test("does not alert when the prices are equal or competitor is higher", async () => {
  const { service, repository } = context();

  assert.equal(await service.evaluate(ownOffer(), competitorOffer(630_000), comparable), null);
  assert.equal(await service.evaluate(ownOffer(), competitorOffer(630_001), comparable), null);
  assert.equal(repository.alerts.length, 0);
});

test("deduplicates the same competitor SKU and price but alerts after another drop", async () => {
  const { service, repository, notifier } = context();

  const first = await service.evaluate(ownOffer(), competitorOffer(629_999), comparable);
  const duplicate = await service.evaluate(ownOffer(), competitorOffer(629_999), comparable);
  const lowerAgain = await service.evaluate(ownOffer(), competitorOffer(629_998), comparable);

  assert.ok(first);
  assert.equal(duplicate, null);
  assert.ok(lowerAgain);
  assert.equal(repository.alerts.length, 2);
  assert.equal(notifier.sent.length, 2);
});

test("marks a lower but differently configured bundle for manual review", async () => {
  const { service } = context();
  const own = { ...ownOffer(800_000), comparisonType: "BUNDLE" as const };
  const competitor = { ...competitorOffer(790_000), comparisonType: "BUNDLE" as const };
  const decision: AlertEvaluationDecision = {
    category: "BUNDLE",
    comparable: false,
    bundleConfiguration: "DIFFERENT",
    reasons: ["核心配件型号不同"]
  };

  const alert = await service.evaluate(own, competitor, decision);

  assert.equal(alert?.severity, "MANUAL_REVIEW");
});

test("keeps the alert and records notification failure for retry", async () => {
  const { service, repository, notifier } = context();
  notifier.error = new Error("wecom timeout");

  const alert = await service.evaluate(ownOffer(), competitorOffer(), comparable);

  assert.ok(alert);
  assert.equal(repository.alerts.length, 1);
  assert.deepEqual(repository.notificationFailures, [{ alertId: "alert-1", message: "wecom timeout" }]);
});
