import "dotenv/config";

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { createPrismaClient } from "../database/prisma.service.ts";
import { AuditService } from "../audit/audit.service.ts";
import { PrismaAuditRepository } from "../audit/prisma-audit.repository.ts";
import {
  AlertService,
  type AlertOffer,
  type PriceAlertNotifier,
  type PriceAlertRecord
} from "./alert.service.ts";
import { AlertActionService } from "./alert-action.service.ts";
import { PrismaAlertRepository } from "./prisma-alert.repository.ts";
import { PrismaAlertActionRepository } from "./prisma-alert-action.repository.ts";

const prisma = createPrismaClient();

async function clearData(): Promise<void> {
  await prisma.alertAction.deleteMany();
  await prisma.priceAlert.deleteMany();
  await prisma.offerSnapshot.deleteMany();
  await prisma.collectionRun.deleteMany();
  await prisma.searchCandidate.deleteMany();
  await prisma.ownListing.deleteMany();
  await prisma.modelAlias.deleteMany();
  await prisma.monitoredModel.deleteMany();
  await prisma.auditLog.deleteMany();
}

class RecordingNotifier implements PriceAlertNotifier {
  sent: PriceAlertRecord[] = [];
  fail = false;

  async sendPriceAlert(alert: PriceAlertRecord) {
    if (this.fail) throw new Error("wecom timeout");
    this.sent.push(alert);
  }
}

async function seedOffers(): Promise<{ own: AlertOffer; competitor: AlertOffer }> {
  const model = await prisma.monitoredModel.create({
    data: {
      monitorCode: "MON-0001",
      brand: "RME",
      standardModel: "Babyface Pro FS",
      category: "声卡",
      searchQuery: "RME Babyface Pro FS",
      comparisonType: "BARE",
      owner: "张三"
    }
  });
  const ownListing = await prisma.ownListing.create({
    data: {
      monitoredModelId: model.id,
      url: "https://detail.tmall.com/item.htm?id=own-1001",
      skuText: "Babyface Pro FS单机"
    }
  });
  const candidate = await prisma.searchCandidate.create({
    data: {
      monitoredModelId: model.id,
      providerKey: "manual-fixtures",
      platformItemId: "competitor-1001",
      url: "https://detail.tmall.com/item.htm?id=competitor-1001",
      shopName: "同行专业音频店",
      title: "RME Babyface Pro FS 官方标配",
      decision: "BARE",
      comparable: true,
      confidenceBps: 9800
    }
  });
  const run = await prisma.collectionRun.create({
    data: {
      monitoredModelId: model.id,
      providerKey: "manual-fixtures",
      status: "SUCCEEDED",
      scheduledFor: new Date("2026-08-19T01:30:00.000Z")
    }
  });
  const ownSnapshot = await prisma.offerSnapshot.create({
    data: {
      collectionRunId: run.id,
      ownListingId: ownListing.id,
      platformItemId: "own-1001",
      skuId: "own-sku",
      shopName: "星空乐器专营店",
      title: "RME Babyface Pro FS",
      skuText: "Babyface Pro FS单机",
      listPriceFen: 630_000,
      payableFen: 630_000,
      capturedAt: new Date("2026-08-19T01:30:00.000Z")
    }
  });
  const competitorSnapshot = await prisma.offerSnapshot.create({
    data: {
      collectionRunId: run.id,
      searchCandidateId: candidate.id,
      platformItemId: "competitor-1001",
      skuId: "competitor-sku",
      shopName: "同行专业音频店",
      title: "RME Babyface Pro FS",
      skuText: "Babyface Pro FS单机",
      listPriceFen: 629_999,
      payableFen: 629_999,
      capturedAt: new Date("2026-08-19T01:30:05.000Z")
    }
  });
  return {
    own: {
      monitoredModelId: model.id,
      snapshotId: ownSnapshot.id,
      platformItemId: "own-1001",
      skuId: "own-sku",
      brand: "RME",
      standardModel: "Babyface Pro FS",
      comparisonType: "BARE",
      shopName: "星空乐器专营店",
      skuText: "Babyface Pro FS单机",
      payableFen: 630_000,
      url: ownListing.url,
      capturedAt: ownSnapshot.capturedAt,
      owner: "张三"
    },
    competitor: {
      monitoredModelId: model.id,
      snapshotId: competitorSnapshot.id,
      platformItemId: "competitor-1001",
      skuId: "competitor-sku",
      brand: "RME",
      standardModel: "Babyface Pro FS",
      comparisonType: "BARE",
      shopName: "同行专业音频店",
      skuText: "Babyface Pro FS单机",
      payableFen: 629_999,
      url: candidate.url,
      capturedAt: competitorSnapshot.capturedAt,
      owner: "张三"
    }
  };
}

before(async () => {
  await prisma.$connect();
});

beforeEach(clearData);

after(async () => {
  await clearData();
  await prisma.$disconnect();
});

test("creates and hydrates an alert without overlapping pg client queries", async () => {
  const warnings: Error[] = [];
  const onWarning = (warning: Error) => {
    if (
      warning.name === "DeprecationWarning"
      && warning.message.includes("client.query() when the client is already executing a query")
    ) {
      warnings.push(warning);
    }
  };
  process.on("warning", onWarning);

  try {
    const offers = await seedOffers();
    const service = new AlertService(new PrismaAlertRepository(prisma), new RecordingNotifier());
    const alert = await service.evaluate(offers.own, offers.competitor, {
      category: "BARE",
      comparable: true,
      bundleConfiguration: "NOT_APPLICABLE",
      reasons: ["同品牌、同型号、同版本裸机"]
    });

    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.ok(alert);
    assert.equal(alert.brand, "RME");
    assert.equal(alert.ownShopName, "星空乐器专营店");
    assert.equal(alert.competitorUrl, "https://detail.tmall.com/item.htm?id=competitor-1001");
    assert.deepEqual(warnings, []);
  } finally {
    process.off("warning", onWarning);
  }
});

test("persists, notifies and deduplicates a one-fen PostgreSQL alert", async () => {
  const offers = await seedOffers();
  const notifier = new RecordingNotifier();
  const service = new AlertService(new PrismaAlertRepository(prisma), notifier);
  const decision = {
    category: "BARE" as const,
    comparable: true,
    bundleConfiguration: "NOT_APPLICABLE" as const,
    reasons: ["同品牌、同型号、同版本裸机"]
  };

  const first = await service.evaluate(offers.own, offers.competitor, decision);
  const duplicate = await service.evaluate(offers.own, offers.competitor, decision);

  assert.ok(first);
  assert.equal(duplicate, null);
  assert.equal(notifier.sent.length, 1);
  const stored = await prisma.priceAlert.findFirstOrThrow();
  assert.equal(stored.differenceFen, 1);
  assert.notEqual(stored.notifiedAt, null);
  assert.equal(stored.notificationAttempts, 1);
  assert.deepEqual(stored.reasons, decision.reasons);
});

test("persists the last notification error for retry", async () => {
  const offers = await seedOffers();
  const notifier = new RecordingNotifier();
  notifier.fail = true;
  const service = new AlertService(new PrismaAlertRepository(prisma), notifier);

  await service.evaluate(offers.own, offers.competitor, {
    category: "BARE",
    comparable: true,
    bundleConfiguration: "NOT_APPLICABLE",
    reasons: ["同品牌、同型号、同版本裸机"]
  });

  const stored = await prisma.priceAlert.findFirstOrThrow();
  assert.equal(stored.notificationAttempts, 1);
  assert.equal(stored.lastNotificationError, "wecom timeout");
  assert.equal(stored.notifiedAt, null);
});

test("updates alert status and appends action and audit history atomically", async () => {
  const offers = await seedOffers();
  const alertService = new AlertService(new PrismaAlertRepository(prisma), new RecordingNotifier());
  const alert = await alertService.evaluate(offers.own, offers.competitor, {
    category: "BARE",
    comparable: true,
    bundleConfiguration: "NOT_APPLICABLE",
    reasons: ["同品牌、同型号、同版本裸机"]
  });
  const actionService = new AlertActionService(
    new PrismaAlertActionRepository(prisma),
    new AuditService(new PrismaAuditRepository(prisma))
  );

  await actionService.applyAction(alert!.id, { status: "WATCHING", note: "观察一小时" }, "operator-1");
  await actionService.applyAction(alert!.id, { status: "PENDING" }, "operator-2");
  await actionService.applyAction(alert!.id, {
    status: "NO_FOLLOW",
    reasonCode: "BELOW_MARGIN",
    note: "低于利润底线"
  }, "operator-3");

  assert.equal((await prisma.priceAlert.findUniqueOrThrow({ where: { id: alert!.id } })).status, "NO_FOLLOW");
  const actions = await actionService.listActions(alert!.id);
  assert.deepEqual(actions.map((action) => action.actorId), ["operator-1", "operator-2", "operator-3"]);
  assert.equal(actions[2]?.reasonCode, "BELOW_MARGIN");
  assert.equal(await prisma.auditLog.count({ where: { entityId: alert!.id } }), 3);
});
