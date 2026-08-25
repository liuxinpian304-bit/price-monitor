import "dotenv/config";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { createPrismaClient } from "../database/prisma.service.ts";
import { RunAlertNotifier } from "../alerts/run-alert-notifier.ts";
import type { WecomMarkdownSender } from "../alerts/wecom/wecom.client.ts";
import { PrismaRunAlertNotificationRepository } from "../alerts/prisma-run-alert-notification.repository.ts";
import { PrismaRunAlertRepository } from "./prisma-run-alert.repository.ts";
import { RunAlertService } from "./run-alert.service.ts";

const prisma = createPrismaClient();

interface PriceFixture {
  key: string;
  payableFen: number;
  skuText?: string;
  priceConfidence?: "CONFIRMED" | "ESTIMATED" | "MANUAL_REVIEW";
  stockState?: "IN_STOCK" | "OUT_OF_STOCK" | "UNKNOWN";
}

async function seedRun(input: {
  modelId: string;
  ownListingId: string;
  index: number;
  prices: PriceFixture[];
}) {
  const run = await prisma.collectionRun.create({
    data: {
      monitoredModelId: input.modelId,
      providerKey: "taobao-desktop",
      status: "SUCCEEDED",
      scheduledFor: new Date(`2026-08-25T0${input.index}:30:00.000Z`),
      startedAt: new Date(`2026-08-25T0${input.index}:30:00.000Z`),
      finishedAt: new Date(`2026-08-25T0${input.index}:31:00.000Z`),
      searchLimit: input.prices.length,
      searchedCount: input.prices.length,
      fetchedCount: input.prices.length + 1,
      discoveredCount: input.prices.length,
      skuCount: input.prices.length + 1
    }
  });
  await prisma.offerSnapshot.create({
    data: {
      collectionRunId: run.id,
      ownListingId: input.ownListingId,
      platformItemId: "own-item",
      skuId: "own-sku",
      shopName: "星空乐器专营店",
      title: "Sony MDR-7506 专业监听耳机",
      skuText: "MDR-7506 单机",
      listPriceFen: 69_800,
      activityPriceFen: 69_800,
      payableFen: 69_800,
      priceConfidence: "CONFIRMED",
      stockState: "IN_STOCK",
      rawEvidence: { source: "taobao-desktop", attributes: { 型号: "MDR-7506 单机" } },
      capturedAt: new Date(`2026-08-25T0${input.index}:30:01.000Z`)
    }
  });
  for (const [offset, price] of input.prices.entries()) {
    const platformItemId = `item-${price.key}`;
    const candidate = await prisma.searchCandidate.upsert({
      where: {
        monitoredModelId_providerKey_platformItemId: {
          monitoredModelId: input.modelId,
          providerKey: "taobao-desktop",
          platformItemId
        }
      },
      create: {
        monitoredModelId: input.modelId,
        providerKey: "taobao-desktop",
        platformItemId,
        url: `https://item.taobao.com/item.htm?id=${platformItemId}`,
        shopName: `同行店铺-${price.key}`,
        title: "Sony MDR-7506 专业监听耳机"
      },
      update: { decision: "PENDING", comparable: false, confidenceBps: 0 }
    });
    await prisma.collectionSearchPosition.create({
      data: {
        collectionRunId: run.id,
        rank: offset + 1,
        platformItemId,
        url: candidate.url,
        shopName: candidate.shopName,
        title: candidate.title,
        displayPriceMinFen: price.payableFen,
        displayPriceMaxFen: price.payableFen,
        capturedAt: new Date(`2026-08-25T0${input.index}:30:02.000Z`)
      }
    });
    const skuText = price.skuText ?? "MDR-7506 单机";
    await prisma.offerSnapshot.create({
      data: {
        collectionRunId: run.id,
        searchCandidateId: candidate.id,
        platformItemId,
        skuId: `sku-${price.key}`,
        shopName: candidate.shopName,
        title: candidate.title,
        skuText,
        listPriceFen: price.payableFen,
        activityPriceFen: price.payableFen,
        payableFen: price.payableFen,
        priceConfidence: price.priceConfidence ?? "CONFIRMED",
        stockState: price.stockState ?? "IN_STOCK",
        rawEvidence: { source: "taobao-desktop", attributes: { 型号: skuText } },
        capturedAt: new Date(`2026-08-25T0${input.index}:30:03.000Z`)
      }
    });
  }
  return run;
}

class RecordingSender implements WecomMarkdownSender {
  messages: string[] = [];
  fail = true;

  async sendMarkdown(message: string) {
    this.messages.push(message);
    if (this.fail) throw new Error("secret webhook and private request body");
  }
}

before(async () => {
  await prisma.$connect();
});
after(async () => {
  await prisma.$disconnect();
});

test("serializes run evaluation, persists decisions, deduplicates prices, and retries one durable batch", async () => {
  const suffix = randomUUID().replaceAll("-", "");
  const model = await prisma.monitoredModel.create({
    data: {
      monitorCode: `T12-${suffix.slice(0, 20)}`,
      brand: "Sony",
      standardModel: "MDR-7506",
      category: "headphones",
      searchQuery: "Sony MDR-7506",
      comparisonType: "BARE",
      owner: "task-12",
      excludedTerms: ["M1", "MV1", "展示样机", "单独转换线"]
    }
  });
  const ownListing = await prisma.ownListing.create({
    data: {
      monitoredModelId: model.id,
      platform: "TAOBAO",
      shopName: "星空乐器专营店",
      platformItemId: "own-item",
      url: "https://item.taobao.com/item.htm?id=own-item",
      skuText: "MDR-7506 单机"
    }
  });

  try {
    const firstRun = await seedRun({
      modelId: model.id,
      ownListingId: ownListing.id,
      index: 1,
      prices: [
        { key: "equal", payableFen: 69_800 },
        { key: "penny", payableFen: 69_799 },
        { key: "low", payableFen: 65_800 },
        { key: "manual", payableFen: 60_000, priceConfidence: "MANUAL_REVIEW" },
        { key: "oos", payableFen: 50_000, stockState: "OUT_OF_STOCK" },
        { key: "wrong", payableFen: 40_000, skuText: "M1" }
      ]
    });
    const service = new RunAlertService(
      new PrismaRunAlertRepository(prisma),
      (runId) => `https://monitor.example.test/collection-runs/${runId}`
    );

    const concurrent = await Promise.all([
      service.evaluateRun(firstRun.id),
      service.evaluateRun(firstRun.id)
    ]);

    assert.equal(concurrent.reduce((count, item) => count + item.alerts.length, 0), 2);
    assert.equal(await prisma.priceAlert.count({ where: { monitoredModelId: model.id } }), 2);
    const decided = await prisma.offerSnapshot.findMany({
      where: { collectionRunId: firstRun.id },
      select: { skuId: true, matchDecision: true, comparable: true }
    });
    assert.equal(decided.every((snapshot) => snapshot.matchDecision !== null), true);
    assert.deepEqual(
      decided.find((snapshot) => snapshot.skuId === "sku-wrong"),
      { skuId: "sku-wrong", matchDecision: "REJECTED", comparable: false }
    );

    const repeatedRun = await seedRun({
      modelId: model.id,
      ownListingId: ownListing.id,
      index: 2,
      prices: [{ key: "low", payableFen: 65_800 }]
    });
    assert.equal((await service.evaluateRun(repeatedRun.id)).alerts.length, 0);

    const lowerRun = await seedRun({
      modelId: model.id,
      ownListingId: ownListing.id,
      index: 3,
      prices: [{ key: "low", payableFen: 65_799 }]
    });
    assert.equal((await service.evaluateRun(lowerRun.id)).alerts.length, 1);
    assert.equal(await prisma.priceAlert.count({ where: { monitoredModelId: model.id } }), 3);

    const summaryWithAlerts = concurrent.find((item) => item.alerts.length === 2)!;
    const sender = new RecordingSender();
    const notifier = new RunAlertNotifier(
      new PrismaRunAlertNotificationRepository(prisma),
      async () => sender
    );
    await notifier.send(summaryWithAlerts);

    const failedBatch = await prisma.runAlertNotificationBatch.findUniqueOrThrow({
      where: { collectionRunId: firstRun.id }
    });
    assert.equal(failedBatch.state, "PENDING");
    assert.equal(failedBatch.notificationAttempts, 1);
    assert.equal(failedBatch.lastNotificationError, "WECOM_DELIVERY_FAILED");
    assert.equal(JSON.stringify(failedBatch).includes("secret webhook"), false);

    sender.fail = false;
    await notifier.send({ ...summaryWithAlerts, brand: "changed", alerts: [] });
    await notifier.send({ ...summaryWithAlerts, alerts: [] });

    assert.equal(sender.messages.length, 2);
    assert.equal(sender.messages[0], sender.messages[1]);
    const notifiedBatch = await prisma.runAlertNotificationBatch.findUniqueOrThrow({
      where: { collectionRunId: firstRun.id }
    });
    assert.equal(notifiedBatch.state, "NOTIFIED");
    assert.equal(notifiedBatch.notificationAttempts, 2);
    assert.notEqual(notifiedBatch.notifiedAt, null);
    const notifiedAlerts = await prisma.priceAlert.findMany({
      where: { id: { in: summaryWithAlerts.alerts.map((alert) => alert.alertId) } }
    });
    assert.equal(notifiedAlerts.every((alert) => alert.notificationAttempts === 2), true);
    assert.equal(notifiedAlerts.every((alert) => alert.notifiedAt !== null), true);
  } finally {
    await prisma.monitoredModel.delete({ where: { id: model.id } });
  }
});
