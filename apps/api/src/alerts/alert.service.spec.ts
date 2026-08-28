import assert from "node:assert/strict";
import test from "node:test";

import {
  AlertService,
  type AlertEvaluationDecision,
  type AlertOffer,
  type AlertRepository,
  type PriceAlertRecord
} from "./alert.service.ts";

function ownOffer(priceFen = 630_000): AlertOffer {
  return {
    monitoredModelId: "model-1",
    snapshotId: "own-snapshot-1",
    combinationSignature: "sku-combination-v1:single",
    platformItemId: "own-1001",
    skuId: "own-sku",
    brand: "RME",
    standardModel: "Babyface Pro FS",
    comparisonType: "BARE",
    shopName: "星空乐器专营店",
    skuText: "Babyface Pro FS单机",
    payableFen: priceFen,
    priceConfidence: "CONFIRMED",
    stockState: "IN_STOCK",
    url: "https://detail.tmall.com/item.htm?id=own-1001",
    capturedAt: new Date("2026-08-19T01:30:00.000Z"),
    owner: "张三"
  };
}

function competitorOffer(priceFen = 629_999): AlertOffer {
  return {
    monitoredModelId: "model-1",
    snapshotId: "competitor-snapshot-1",
    combinationSignature: "sku-combination-v1:single",
    platformItemId: "competitor-1001",
    skuId: "competitor-sku",
    brand: "RME",
    standardModel: "Babyface Pro FS",
    comparisonType: "BARE",
    shopName: "同行专业音频店",
    skuText: "Babyface Pro FS单机",
    payableFen: priceFen,
    priceConfidence: "CONFIRMED",
    stockState: "IN_STOCK",
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

  async createIfAbsent(input: Omit<PriceAlertRecord, "id" | "notifiedAt">) {
    if (this.alerts.some((alert) => alert.dedupKey === input.dedupKey)) return null;
    const alert = { ...input, id: `alert-${this.alerts.length + 1}`, notifiedAt: null };
    this.alerts.push(alert);
    return alert;
  }

  async markBatchNotified(ids: string[], notifiedAt: Date) {
    for (const alert of this.alerts.filter((item) => ids.includes(item.id))) {
      alert.notifiedAt = notifiedAt;
    }
  }

  async recordBatchNotificationFailure(_ids: string[], _message: string) {}
}

function context() {
  const repository = new FakeAlertRepository();
  return { repository, service: new AlertService(repository) };
}

test("persists an alert without notifying when the competitor is lower by one fen", async () => {
  const { service, repository } = context();

  const alert = await service.evaluate(ownOffer(), competitorOffer(), comparable);

  assert.equal(alert?.severity, "CONFIRMED_LOW");
  assert.equal(alert?.differenceFen, 1);
  assert.equal(repository.alerts.length, 1);
  assert.equal(repository.alerts[0]?.notifiedAt, null);
});

test("does not alert when the prices are equal or competitor is higher", async () => {
  const { service, repository } = context();

  assert.equal(await service.evaluate(ownOffer(), competitorOffer(630_000), comparable), null);
  assert.equal(await service.evaluate(ownOffer(), competitorOffer(630_001), comparable), null);
  assert.equal(repository.alerts.length, 0);
});

test("deduplicates the same competitor SKU and price but alerts after another drop", async () => {
  const { service, repository } = context();

  const first = await service.evaluate(ownOffer(), competitorOffer(629_999), comparable);
  const duplicate = await service.evaluate(ownOffer(), competitorOffer(629_999), comparable);
  const lowerAgain = await service.evaluate(ownOffer(), competitorOffer(629_998), comparable);

  assert.ok(first);
  assert.equal(duplicate, null);
  assert.ok(lowerAgain);
  assert.equal(repository.alerts.length, 2);
});

test("price-v3 identity includes the combination signature and selected own snapshot", async () => {
  const { service, repository } = context();

  const first = await service.evaluate(ownOffer(), competitorOffer(), comparable);
  const otherCombination = await service.evaluate(
    { ...ownOffer(), combinationSignature: "sku-combination-v1:bundle" },
    { ...competitorOffer(), combinationSignature: "sku-combination-v1:bundle" },
    comparable
  );
  const otherOwnSnapshot = await service.evaluate(
    { ...ownOffer(), snapshotId: "own-snapshot-2" },
    competitorOffer(),
    comparable
  );

  assert.ok(first);
  assert.ok(otherCombination);
  assert.ok(otherOwnSnapshot);
  assert.equal(repository.alerts.length, 3);
  assert.equal(repository.alerts.every((alert) => alert.dedupKey.startsWith("price-v3:")), true);
  assert.equal(new Set(repository.alerts.map((alert) => alert.dedupKey)).size, 3);
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

test("rejects uncertain or unavailable prices before persistence", async () => {
  const { service, repository } = context();

  assert.equal(await service.evaluate(
    ownOffer(),
    { ...competitorOffer(), priceConfidence: "MANUAL_REVIEW" },
    comparable
  ), null);
  assert.equal(await service.evaluate(
    ownOffer(),
    { ...competitorOffer(), priceConfidence: "ESTIMATED" },
    comparable
  ), null);
  assert.equal(await service.evaluate(
    ownOffer(),
    { ...competitorOffer(), stockState: "OUT_OF_STOCK" },
    comparable
  ), null);
  assert.equal(await service.evaluate(
    { ...ownOffer(), priceConfidence: "MANUAL_REVIEW" },
    competitorOffer(),
    comparable
  ), null);

  assert.equal(repository.alerts.length, 0);
});
