import "dotenv/config";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { Prisma } from "../../../../generated/prisma/client.ts";
import { createPrismaClient } from "../database/prisma.service.ts";
import { RunAlertNotifier } from "../alerts/run-alert-notifier.ts";
import { RunAlertReconciler } from "../alerts/run-alert-reconciler.ts";
import {
  WecomDeliveryAmbiguousError,
  type WecomMarkdownSender
} from "../alerts/wecom/wecom.client.ts";
import { PrismaRunAlertNotificationRepository } from "../alerts/prisma-run-alert-notification.repository.ts";
import {
  PrismaRunAlertRepository,
  RunAlertEvaluationError
} from "./prisma-run-alert.repository.ts";
import {
  RunAlertService,
  type RunAlertSummary,
  type RunAlertUnitOfWork
} from "./run-alert.service.ts";

const prisma = createPrismaClient();

interface PriceFixture {
  key: string;
  payableFen: number;
  displayPriceFen?: number;
  skuText?: string;
  components?: BundleComponentFixture[] | null;
  priceConfidence?: "CONFIRMED" | "ESTIMATED" | "MANUAL_REVIEW";
  stockState?: "IN_STOCK" | "OUT_OF_STOCK" | "UNKNOWN";
}

interface BundleComponentFixture {
  role: "CORE" | "PAID_ACCESSORY" | "GIFT_OR_SERVICE" | "UNKNOWN";
  accessoryType: string;
  brand: string | null;
  modelOrName: string;
  quantity: number;
}

const coreComponent: BundleComponentFixture = {
  role: "CORE",
  accessoryType: "耳机",
  brand: "Sony",
  modelOrName: "MDR-7506",
  quantity: 1
};

function rawEvidence(
  skuText: string,
  components?: BundleComponentFixture[]
): Prisma.InputJsonObject {
  const jsonComponents = components?.map((component): Prisma.InputJsonObject => ({
    role: component.role,
    accessoryType: component.accessoryType,
    brand: component.brand,
    modelOrName: component.modelOrName,
    quantity: component.quantity
  }));
  return {
    source: "taobao-desktop",
    attributes: { 型号: skuText },
    ...(jsonComponents === undefined ? {} : { components: jsonComponents })
  };
}

async function seedRun(input: {
  modelId: string;
  ownListingId: string;
  index: number;
  prices: PriceFixture[];
  ownSkuText?: string;
  ownComponents?: BundleComponentFixture[];
}) {
  const ownSkuText = input.ownSkuText ?? "MDR-7506 单机";
  const run = await prisma.collectionRun.create({
    data: {
      monitoredModelId: input.modelId,
      providerKey: "taobao-desktop",
      status: "SUCCEEDED",
      scheduledFor: new Date(`2026-08-25T0${input.index}:30:00.000Z`),
      startedAt: new Date(`2026-08-25T0${input.index}:30:00.000Z`),
      finishedAt: new Date(`2026-08-25T0${input.index}:31:00.000Z`),
      claimedOwnListingIds: [input.ownListingId],
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
      skuText: ownSkuText,
      listPriceFen: 69_800,
      activityPriceFen: 69_800,
      payableFen: 69_800,
      priceConfidence: "CONFIRMED",
      stockState: "IN_STOCK",
      rawEvidence: rawEvidence(ownSkuText, input.ownComponents ?? [coreComponent]),
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
        displayPriceMinFen: price.displayPriceFen ?? price.payableFen,
        displayPriceMaxFen: price.displayPriceFen ?? price.payableFen,
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
        rawEvidence: rawEvidence(
          skuText,
          price.components === undefined ? [coreComponent] : price.components ?? undefined
        ),
        capturedAt: new Date(`2026-08-25T0${input.index}:30:03.000Z`)
      }
    });
  }
  return run;
}

async function seedEvaluationFixture(label: string, index: number) {
  const suffix = randomUUID().replaceAll("-", "");
  const model = await prisma.monitoredModel.create({
    data: {
      monitorCode: `T3-${label}-${suffix.slice(0, 12)}`,
      brand: "Sony",
      standardModel: "MDR-7506",
      category: "headphones",
      searchQuery: "Sony MDR-7506",
      comparisonType: "BARE",
      owner: "task-3-transaction"
    }
  });
  const ownListing = await prisma.ownListing.create({
    data: {
      monitoredModelId: model.id,
      platform: "TAOBAO",
      shopName: "星空乐器专营店",
      platformItemId: `own-${label}-${suffix.slice(0, 8)}`,
      url: `https://item.taobao.com/item.htm?id=own-${label}`,
      skuText: "MDR-7506 单机"
    }
  });
  const run = await seedRun({
    modelId: model.id,
    ownListingId: ownListing.id,
    index,
    prices: [{ key: `${label}-${suffix.slice(0, 8)}`, payableFen: 65_000 }]
  });
  return { model, run };
}

async function createTransactionalSummary(
  unit: RunAlertUnitOfWork,
  dedupKey: string
): Promise<RunAlertSummary> {
  const own = unit.data.snapshots.find((snapshot) => snapshot.ownListingId !== null)!;
  const competitor = unit.data.snapshots.find((snapshot) => snapshot.searchCandidateId !== null)!;
  const alert = await unit.alerts.createIfAbsent({
    monitoredModelId: unit.data.model.id,
    severity: "CONFIRMED_LOW",
    status: "PENDING",
    dedupKey,
    brand: unit.data.model.brand,
    standardModel: unit.data.model.standardModel,
    comparisonType: unit.data.model.comparisonType,
    owner: unit.data.model.owner,
    ownSnapshotId: own.id,
    competitorSnapshotId: competitor.id,
    ownShopName: own.shopName,
    ownSkuText: own.skuText,
    ownPriceFen: own.payableFen!,
    competitorShopName: competitor.shopName,
    competitorSkuText: competitor.skuText,
    competitorPriceFen: competitor.payableFen!,
    competitorItemId: competitor.platformItemId,
    competitorSkuId: competitor.skuId,
    competitorUrl: competitor.url,
    differenceFen: own.payableFen! - competitor.payableFen!,
    reasons: ["simulated transactional alert"],
    firstSeenAt: competitor.capturedAt,
    lastSeenAt: competitor.capturedAt
  });
  assert.ok(alert);
  return {
    runId: unit.data.runId,
    monitoredModelId: unit.data.model.id,
    brand: unit.data.model.brand,
    standardModel: unit.data.model.standardModel,
    comparisonType: unit.data.model.comparisonType,
    owner: unit.data.model.owner,
    completedAt: unit.data.completedAt,
    checkedItemCount: 1,
    positionCount: unit.data.positionCount,
    shopCount: 1,
    searchLimit: unit.data.searchLimit,
    skuCount: unit.data.skuCount,
    issueCount: unit.data.issueCount,
    reviewCount: 0,
    reportUrl: `https://monitor.example.test/collection-runs/${unit.data.runId}`,
    baseline: {
      snapshotId: own.id,
      skuId: own.skuId,
      skuText: own.skuText,
      activityPriceFen: own.activityPriceFen,
      publicDiscountFen: own.publicDiscountFen,
      payableFen: own.payableFen!
    },
    systemIssue: null,
    alerts: [{
      alertId: alert.id,
      severity: alert.severity,
      snapshotId: competitor.id,
      ownSnapshotId: own.id,
      ownSkuText: own.skuText,
      ownPayableFen: own.payableFen!,
      combinationSignature: "sku-combination-v1:transaction-fixture",
      combinationLabel: "Sony MDR-7506 新品 核心耳机MDR-7506x1",
      rank: competitor.searchRanks[0] ?? null,
      shopName: competitor.shopName,
      title: competitor.title,
      skuText: competitor.skuText,
      activityPriceFen: competitor.activityPriceFen,
      publicDiscountFen: competitor.publicDiscountFen,
      payableFen: competitor.payableFen!,
      differenceFen: alert.differenceFen,
      url: competitor.url,
      reasons: alert.reasons
    }],
    missingOwnGroups: []
  };
}

class RecordingSender implements WecomMarkdownSender {
  messages: string[] = [];
  fail = true;

  async sendMarkdown(message: string) {
    this.messages.push(message);
    if (this.fail) throw new Error("secret webhook and private request body");
  }
}

class AmbiguousSender implements WecomMarkdownSender {
  calls = 0;

  async sendMarkdown() {
    this.calls += 1;
    throw new WecomDeliveryAmbiguousError();
  }
}

before(async () => {
  await prisma.$connect();
});
after(async () => {
  await prisma.$disconnect();
});

test("commits per-combination baselines, alerts, missing groups, and one batch atomically", async () => {
  const suffix = randomUUID().replaceAll("-", "");
  const model = await prisma.monitoredModel.create({
    data: {
      monitorCode: `T5-COMBO-${suffix.slice(0, 16)}`,
      brand: "Sony",
      standardModel: "MDR-7506",
      category: "headphones",
      searchQuery: "Sony MDR-7506",
      comparisonType: "BARE",
      owner: "task-5"
    }
  });
  const firstOwnListing = await prisma.ownListing.create({
    data: {
      monitoredModelId: model.id,
      platform: "TAOBAO",
      shopName: "星空乐器专营店",
      platformItemId: `own-first-${suffix.slice(0, 8)}`,
      url: `https://item.taobao.com/item.htm?id=own-first-${suffix.slice(0, 8)}`,
      skuText: "MDR-7506 单机"
    }
  });

  try {
    const run = await seedRun({
      modelId: model.id,
      ownListingId: firstOwnListing.id,
      index: 8,
      prices: [
        {
          key: `detail-low-${suffix.slice(0, 8)}`,
          payableFen: 68_999,
          displayPriceFen: 1
        },
        {
          key: `missing-${suffix.slice(0, 8)}`,
          payableFen: 65_000,
          components: [coreComponent, {
            role: "PAID_ACCESSORY",
            accessoryType: "耳机架",
            brand: null,
            modelOrName: "HPS-1",
            quantity: 1
          }]
        },
        {
          key: `malformed-role-${suffix.slice(0, 8)}`,
          payableFen: 64_000
        }
      ]
    });
    const secondOwnListing = await prisma.ownListing.create({
      data: {
        monitoredModelId: model.id,
        platform: "TAOBAO",
        shopName: "星空乐器专营店",
        platformItemId: `own-lowest-${suffix.slice(0, 8)}`,
        url: `https://item.taobao.com/item.htm?id=own-lowest-${suffix.slice(0, 8)}`,
        skuText: "MDR-7506 单机"
      }
    });
    const lowestOwnSnapshot = await prisma.offerSnapshot.create({
      data: {
        collectionRunId: run.id,
        ownListingId: secondOwnListing.id,
        platformItemId: secondOwnListing.platformItemId!,
        skuId: "own-lowest-sku",
        shopName: secondOwnListing.shopName,
        title: "Sony MDR-7506 专业监听耳机",
        skuText: "MDR-7506 单机",
        listPriceFen: 69_000,
        activityPriceFen: 69_000,
        payableFen: 69_000,
        priceConfidence: "CONFIRMED",
        stockState: "IN_STOCK",
        rawEvidence: rawEvidence("MDR-7506 单机", [coreComponent]),
        capturedAt: new Date("2026-08-25T08:30:04.000Z")
      }
    });
    await prisma.collectionRun.update({
      where: { id: run.id },
      data: {
        claimedOwnListingIds: [firstOwnListing.id, secondOwnListing.id],
        skuCount: { increment: 1 }
      }
    });
    const competitorSnapshot = await prisma.offerSnapshot.findFirstOrThrow({
      where: { collectionRunId: run.id, skuId: `sku-detail-low-${suffix.slice(0, 8)}` }
    });
    const missingSnapshot = await prisma.offerSnapshot.findFirstOrThrow({
      where: { collectionRunId: run.id, skuId: `sku-missing-${suffix.slice(0, 8)}` }
    });
    const malformedRoleSnapshot = await prisma.offerSnapshot.findFirstOrThrow({
      where: { collectionRunId: run.id, skuId: `sku-malformed-role-${suffix.slice(0, 8)}` }
    });
    await prisma.offerSnapshot.update({
      where: { id: malformedRoleSnapshot.id },
      data: {
        rawEvidence: rawEvidence("MDR-7506 单机", [{
          ...coreComponent,
          role: "INVALID_ROLE" as BundleComponentFixture["role"]
        }])
      }
    });
    const service = new RunAlertService(
      new PrismaRunAlertRepository(prisma),
      (runId) => `https://monitor.example.test/collection-runs/${runId}`
    );

    const summary = await service.evaluateRun(run.id);

    await prisma.$transaction(async (transaction) => {
      const competitor = await transaction.offerSnapshot.findUniqueOrThrow({
        where: { id: competitorSnapshot.id }
      });
      const missing = await transaction.offerSnapshot.findUniqueOrThrow({
        where: { id: missingSnapshot.id }
      });
      const malformedRole = await transaction.offerSnapshot.findUniqueOrThrow({
        where: { id: malformedRoleSnapshot.id }
      });
      const alert = await transaction.priceAlert.findFirstOrThrow({
        where: { competitorSnapshotId: competitor.id }
      });
      assert.equal(competitor.combinationState, "MATCHED");
      assert.equal(competitor.comparisonOwnSnapshotId, lowestOwnSnapshot.id);
      assert.equal(alert.ownSnapshotId, lowestOwnSnapshot.id);
      assert.equal(alert.competitorPriceFen, 68_999);
      assert.equal(alert.dedupKey.startsWith("price-v3:"), true);
      assert.equal(missing.combinationState, "MISSING_OWN");
      assert.equal(missing.comparisonOwnSnapshotId, null);
      assert.equal(malformedRole.combinationState, "REVIEW");
      assert.equal(malformedRole.comparisonOwnSnapshotId, null);
      assert.equal(await transaction.priceAlert.count({ where: { competitorSnapshotId: missing.id } }), 0);
      assert.equal(await transaction.collectionIssue.count({ where: { collectionRunId: run.id } }), 0);
      assert.equal(await transaction.runAlertNotificationBatch.count({ where: { collectionRunId: run.id } }), 1);
    });
    assert.equal(summary.alerts[0]?.ownSnapshotId, lowestOwnSnapshot.id);
    assert.equal(summary.alerts[0]?.differenceFen, 1);
    assert.equal(summary.missingOwnGroups.length, 1);
    assert.equal(summary.reviewCount, 1);

    await service.evaluateRun(run.id);
    assert.equal(await prisma.priceAlert.count({ where: { competitorSnapshotId: competitorSnapshot.id } }), 1);
    assert.equal(await prisma.runAlertNotificationBatch.count({ where: { collectionRunId: run.id } }), 1);
  } finally {
    await prisma.monitoredModel.delete({ where: { id: model.id } });
  }
});

test("fails closed when an own listing is only partially enumerated", async () => {
  const suffix = randomUUID().replaceAll("-", "");
  const model = await prisma.monitoredModel.create({
    data: {
      monitorCode: `T5-PARTIAL-${suffix.slice(0, 14)}`,
      brand: "Sony",
      standardModel: "MDR-7506",
      category: "headphones",
      searchQuery: "Sony MDR-7506",
      comparisonType: "BARE",
      owner: "final-fix-wave"
    }
  });
  const ownListing = await prisma.ownListing.create({
    data: {
      monitoredModelId: model.id,
      platform: "TAOBAO",
      shopName: "星空乐器专营店",
      platformItemId: "own-item",
      url: `https://item.taobao.com/item.htm?id=own-${suffix.slice(0, 8)}`,
      skuText: "MDR-7506 单机"
    }
  });

  try {
    const run = await seedRun({
      modelId: model.id,
      ownListingId: ownListing.id,
      index: 7,
      prices: [{
        key: `missing-bundle-${suffix.slice(0, 8)}`,
        payableFen: 65_000,
        components: [coreComponent, {
          role: "PAID_ACCESSORY",
          accessoryType: "耳机架",
          brand: null,
          modelOrName: "HPS-1",
          quantity: 1
        }]
      }]
    });
    await prisma.collectionIssue.create({
      data: {
        collectionRunId: run.id,
        issueKey: `sha256:${suffix.padEnd(64, "0").slice(0, 64)}`,
        code: "SKU_ENUMERATION_INCOMPLETE",
        platformItemId: "own-item",
        message: "One own SKU selection was not collected",
        capturedAt: run.finishedAt!
      }
    });
    const service = new RunAlertService(
      new PrismaRunAlertRepository(prisma),
      (runId) => `https://monitor.example.test/collection-runs/${runId}`
    );

    const summary = await service.evaluateRun(run.id);
    const competitor = await prisma.offerSnapshot.findFirstOrThrow({
      where: { collectionRunId: run.id, searchCandidateId: { not: null } }
    });
    const reasonPayload = competitor.combinationReasons as { codes?: unknown } | null;

    assert.equal(competitor.combinationState, "REVIEW");
    assert.deepEqual(reasonPayload?.codes, ["OWN_CATALOG_INCOMPLETE"]);
    assert.equal(summary.missingOwnGroups.length, 0);
    assert.equal(await prisma.priceAlert.count({ where: { competitorSnapshotId: competitor.id } }), 0);
  } finally {
    await prisma.monitoredModel.delete({ where: { id: model.id } });
  }
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
    const summaryWithAlerts = concurrent.find((item) => item.alerts.length === 2)!;

    assert.equal(concurrent.reduce((count, item) => count + item.alerts.length, 0), 2);
    assert.equal(await prisma.priceAlert.count({ where: { monitoredModelId: model.id } }), 2);
    const committedBatch = await prisma.runAlertNotificationBatch.findUniqueOrThrow({
      where: { collectionRunId: firstRun.id }
    });
    assert.deepEqual(
      committedBatch.alertIds.sort(),
      summaryWithAlerts.alerts.map((alert) => alert.alertId).sort()
    );
    assert.equal(committedBatch.state, "PENDING");

    const restartedSender = new RecordingSender();
    restartedSender.fail = false;
    const restartedNotificationRepository = new PrismaRunAlertNotificationRepository(prisma);
    const restartedNotifier = new RunAlertNotifier(
      restartedNotificationRepository,
      async () => restartedSender,
      async () => true
    );
    const restartedReconciler = new RunAlertReconciler(
      {
        claimRun: async () => null,
        markEvaluated: async () => undefined,
        recordEvaluationFailure: async () => undefined
      },
      { evaluateRun: async () => { throw new Error("unexpected evaluation"); } },
      restartedNotifier,
      restartedNotificationRepository
    );
    await restartedReconciler.reconcilePending();
    await restartedReconciler.reconcilePending();
    assert.equal(restartedSender.messages.length, 1);

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
    assert.equal((await service.evaluateRun(repeatedRun.id)).alerts.length, 1);
    assert.notEqual(await prisma.runAlertNotificationBatch.findUnique({
      where: { collectionRunId: repeatedRun.id }
    }), null);

    const lowerRun = await seedRun({
      modelId: model.id,
      ownListingId: ownListing.id,
      index: 3,
      prices: [{ key: "low", payableFen: 65_799 }]
    });
    const lowerSummary = await service.evaluateRun(lowerRun.id);
    assert.equal(lowerSummary.alerts.length, 1);
    assert.equal(await prisma.priceAlert.count({ where: { monitoredModelId: model.id } }), 4);

    const evaluatedRun = await prisma.collectionRun.findUniqueOrThrow({
      where: { id: firstRun.id },
      select: { ownBaselineSnapshotId: true }
    });
    assert.equal(evaluatedRun.ownBaselineSnapshotId, summaryWithAlerts.baseline?.snapshotId);

    const ambiguousSender = new AmbiguousSender();
    const ambiguousNotifier = new RunAlertNotifier(
      new PrismaRunAlertNotificationRepository(prisma),
      async () => ambiguousSender,
      async () => true
    );
    await ambiguousNotifier.send(lowerSummary);
    await ambiguousNotifier.send(lowerSummary);
    assert.equal(ambiguousSender.calls, 1);
    const ambiguousBatch = await prisma.runAlertNotificationBatch.findUniqueOrThrow({
      where: { collectionRunId: lowerRun.id }
    });
    assert.equal(ambiguousBatch.state, "AMBIGUOUS");
    assert.equal(ambiguousBatch.lastNotificationError, "WECOM_DELIVERY_AMBIGUOUS");

    const retryRun = await seedRun({
      modelId: model.id,
      ownListingId: ownListing.id,
      index: 5,
      prices: [{ key: "retry", payableFen: 65_798 }]
    });
    const retrySummary = await service.evaluateRun(retryRun.id);
    assert.equal(retrySummary.alerts.length, 1);

    const sender = new RecordingSender();
    const notifier = new RunAlertNotifier(
      new PrismaRunAlertNotificationRepository(prisma),
      async () => sender,
      async () => true
    );
    await notifier.send(retrySummary);

    const failedBatch = await prisma.runAlertNotificationBatch.findUniqueOrThrow({
      where: { collectionRunId: retryRun.id }
    });
    assert.equal(failedBatch.state, "PENDING");
    assert.equal(failedBatch.notificationAttempts, 1);
    assert.equal(failedBatch.lastNotificationError, "WECOM_DELIVERY_FAILED");
    assert.equal(JSON.stringify(failedBatch).includes("secret webhook"), false);

    const abandonedRun = await seedRun({
      modelId: model.id,
      ownListingId: ownListing.id,
      index: 4,
      prices: [{ key: "abandoned", payableFen: 69_800 }]
    });
    const abandonedSummary = {
      ...summaryWithAlerts,
      runId: abandonedRun.id,
      baseline: null,
      systemIssue: "OWN_BASELINE_MISSING" as const,
      alerts: []
    };
    await prisma.runAlertNotificationBatch.create({
      data: {
        collectionRunId: abandonedRun.id,
        summary: JSON.parse(JSON.stringify(abandonedSummary)) as Prisma.InputJsonValue,
        alertIds: [],
        state: "SENDING",
        attemptToken: randomUUID(),
        attemptStartedAt: new Date("2026-08-25T00:00:00.000Z"),
        notificationAttempts: 1
      }
    });
    const abandonedSender = new RecordingSender();
    abandonedSender.fail = false;
    await new RunAlertNotifier(
      new PrismaRunAlertNotificationRepository(prisma),
      async () => abandonedSender,
      async () => true
    ).send(abandonedSummary);
    assert.equal(abandonedSender.messages.length, 0);
    const retryable = await new PrismaRunAlertNotificationRepository(prisma)
      .listRetryableSummaries(new Date("2026-08-25T01:00:00.000Z"), 25);
    assert.equal(retryable.some((summary) => summary.runId === abandonedRun.id), false);
    const abandonedBatch = await prisma.runAlertNotificationBatch.findUniqueOrThrow({
      where: { collectionRunId: abandonedRun.id }
    });
    assert.equal(abandonedBatch.state, "AMBIGUOUS");
    assert.equal(abandonedBatch.lastNotificationError, "WECOM_DELIVERY_AMBIGUOUS");

    sender.fail = false;
    await notifier.send({ ...retrySummary, brand: "changed", alerts: [] });
    await notifier.send({ ...retrySummary, alerts: [] });

    assert.equal(sender.messages.length, 2);
    assert.equal(sender.messages[0], sender.messages[1]);
    const notifiedBatch = await prisma.runAlertNotificationBatch.findUniqueOrThrow({
      where: { collectionRunId: retryRun.id }
    });
    assert.equal(notifiedBatch.state, "NOTIFIED");
    assert.equal(notifiedBatch.notificationAttempts, 2);
    assert.notEqual(notifiedBatch.notifiedAt, null);
    const notifiedAlerts = await prisma.priceAlert.findMany({
      where: { id: { in: retrySummary.alerts.map((alert) => alert.alertId) } }
    });
    assert.equal(notifiedAlerts.every((alert) => alert.notificationAttempts === 2), true);
    assert.equal(notifiedAlerts.every((alert) => alert.notifiedAt !== null), true);
  } finally {
    await prisma.monitoredModel.delete({ where: { id: model.id } });
  }
});

test("rejects a notification summary for a different run", async () => {
  const { model, run } = await seedEvaluationFixture("mismatch", 6);
  const dedupKey = `task-3-mismatch-${randomUUID()}`;
  const repository = new PrismaRunAlertRepository(prisma);

  try {
    await assert.rejects(
      repository.withEvaluation(run.id, async (unit) => {
        const summary = await createTransactionalSummary(unit, dedupKey);
        await unit.ensureNotificationBatch({ ...summary, runId: "different-run" });
      }),
      (error: unknown) => {
        assert.equal(error instanceof RunAlertEvaluationError, true);
        return true;
      }
    );
    assert.equal(await prisma.priceAlert.count({ where: { dedupKey } }), 0);
    assert.equal(await prisma.runAlertNotificationBatch.findUnique({
      where: { collectionRunId: run.id }
    }), null);
  } finally {
    await prisma.monitoredModel.delete({ where: { id: model.id } });
  }
});

test("rejects a comparison baseline snapshot from a different run", async () => {
  const first = await seedEvaluationFixture("same-run-first", 6);
  const second = await seedEvaluationFixture("same-run-second", 9);
  const repository = new PrismaRunAlertRepository(prisma);

  try {
    const foreignOwn = await prisma.offerSnapshot.findFirstOrThrow({
      where: { collectionRunId: second.run.id, ownListingId: { not: null } }
    });
    const target = await prisma.offerSnapshot.findFirstOrThrow({
      where: { collectionRunId: first.run.id, searchCandidateId: { not: null } }
    });

    await assert.rejects(
      repository.withEvaluation(first.run.id, async (unit) => {
        await unit.saveCombinationDecisions([{
          snapshotId: target.id,
          signature: "sku-combination-v1:foreign",
          label: "foreign baseline",
          state: "MATCHED",
          comparisonOwnSnapshotId: foreignOwn.id,
          reasons: { ruleVersion: "sku-combination-v1", codes: ["EXACT_SIGNATURE"] }
        }]);
      }),
      (error: unknown) => {
        assert.equal(error instanceof RunAlertEvaluationError, true);
        return true;
      }
    );
    const unchanged = await prisma.offerSnapshot.findUniqueOrThrow({ where: { id: target.id } });
    assert.equal(unchanged.combinationState, null);
    assert.equal(unchanged.comparisonOwnSnapshotId, null);
  } finally {
    await prisma.monitoredModel.delete({ where: { id: first.model.id } });
    await prisma.monitoredModel.delete({ where: { id: second.model.id } });
  }
});

test("rolls back the alert and notification batch on a pre-commit crash", async () => {
  const { model, run } = await seedEvaluationFixture("rollback", 7);
  const dedupKey = `task-3-rollback-${randomUUID()}`;
  const repository = new PrismaRunAlertRepository(prisma);

  try {
    await assert.rejects(
      repository.withEvaluation(run.id, async (unit) => {
        const own = unit.data.snapshots.find((snapshot) => snapshot.ownListingId !== null)!;
        const competitor = unit.data.snapshots.find((snapshot) => snapshot.searchCandidateId !== null)!;
        await unit.saveCombinationDecisions([
          {
            snapshotId: own.id,
            signature: "sku-combination-v1:rollback",
            label: "rollback own",
            state: "OWN",
            comparisonOwnSnapshotId: null,
            reasons: { ruleVersion: "sku-combination-v1", codes: [] }
          },
          {
            snapshotId: competitor.id,
            signature: "sku-combination-v1:rollback",
            label: "rollback competitor",
            state: "MATCHED",
            comparisonOwnSnapshotId: own.id,
            reasons: { ruleVersion: "sku-combination-v1", codes: ["EXACT_SIGNATURE"] }
          }
        ]);
        const summary = await createTransactionalSummary(unit, dedupKey);
        await unit.ensureNotificationBatch(summary);
        throw new Error("simulated pre-commit crash");
      }),
      /simulated pre-commit crash/
    );
    assert.equal(await prisma.priceAlert.count({ where: { dedupKey } }), 0);
    assert.equal(await prisma.runAlertNotificationBatch.findUnique({
      where: { collectionRunId: run.id }
    }), null);
    const rolledBackSnapshots = await prisma.offerSnapshot.findMany({
      where: { collectionRunId: run.id },
      select: { combinationState: true, comparisonOwnSnapshotId: true }
    });
    assert.equal(rolledBackSnapshots.every((snapshot) => snapshot.combinationState === null), true);
    assert.equal(rolledBackSnapshots.every((snapshot) => snapshot.comparisonOwnSnapshotId === null), true);
  } finally {
    await prisma.monitoredModel.delete({ where: { id: model.id } });
  }
});

test("compares only exact structured bundle signatures after Prisma persistence", async () => {
  const suffix = randomUUID().replaceAll("-", "");
  const exactComponents: BundleComponentFixture[] = [
    { role: "CORE", accessoryType: "耳机", brand: "Sony", modelOrName: "MDR-7506", quantity: 1 },
    { role: "PAID_ACCESSORY", accessoryType: "转换线", brand: null, modelOrName: "C口转换线", quantity: 1 }
  ];
  const bundle = await prisma.bundle.create({
    data: {
      code: `T12-B-${suffix.slice(0, 20)}`,
      title: "MDR-7506 C口转换线套装",
      items: {
        create: exactComponents.map(({ role: _role, ...component }) => ({
          ...component,
          unitValueFen: 0,
          core: true
        }))
      }
    }
  });
  const model = await prisma.monitoredModel.create({
    data: {
      monitorCode: `T12-BM-${suffix.slice(0, 18)}`,
      brand: "Sony",
      standardModel: "MDR-7506",
      category: "headphones",
      searchQuery: "Sony MDR-7506 C口转换线套装",
      comparisonType: "BUNDLE",
      owner: "task-12",
      bundleId: bundle.id,
      excludedTerms: ["M1", "MV1"]
    }
  });
  const ownSkuText = "MDR-7506 + C口转换线套装";
  const ownListing = await prisma.ownListing.create({
    data: {
      monitoredModelId: model.id,
      platform: "TAOBAO",
      shopName: "星空乐器专营店",
      platformItemId: "own-bundle-item",
      url: "https://item.taobao.com/item.htm?id=own-bundle-item",
      skuText: ownSkuText
    }
  });

  try {
    const run = await seedRun({
      modelId: model.id,
      ownListingId: ownListing.id,
      index: 4,
      ownSkuText,
      ownComponents: exactComponents,
      prices: [
        {
          key: "bundle-exact",
          payableFen: 69_799,
          skuText: "C口转换线 + MDR-7506 套装",
          components: exactComponents
        },
        {
          key: "bundle-x2",
          payableFen: 68_000,
          skuText: "MDR-7506 + C口转换线 x2 套装",
          components: [exactComponents[0]!, { ...exactComponents[1]!, quantity: 2 }]
        },
        {
          key: "bundle-two-cables",
          payableFen: 67_000,
          skuText: "MDR-7506 + C口转换线2条 套装",
          components: [exactComponents[0]!, { ...exactComponents[1]!, quantity: 2 }]
        },
        {
          key: "bundle-missing",
          payableFen: 66_000,
          skuText: "MDR-7506 套装",
          components: [exactComponents[0]!]
        },
        {
          key: "bundle-extra",
          payableFen: 65_000,
          skuText: "MDR-7506 + C口转换线 + 防尘收纳盒套装",
          components: [
            ...exactComponents,
            { role: "PAID_ACCESSORY", accessoryType: "收纳", brand: null, modelOrName: "防尘收纳盒", quantity: 1 }
          ]
        },
        {
          key: "bundle-unstructured",
          payableFen: 64_000,
          skuText: "MDR-7506 + C口转换线套装",
          components: null
        }
      ]
    });

    const summary = await new RunAlertService(
      new PrismaRunAlertRepository(prisma),
      (runId) => `https://monitor.example.test/collection-runs/${runId}`
    ).evaluateRun(run.id);

    assert.deepEqual(
      summary.alerts.map((alert) => [alert.severity, alert.skuText]),
      [
        ["CONFIRMED_LOW", "C口转换线 + MDR-7506 套装"]
      ]
    );
    assert.equal(summary.missingOwnGroups.length, 3);
    assert.equal(summary.reviewCount, 1);
    const decisions = await prisma.offerSnapshot.findMany({
      where: { collectionRunId: run.id, searchCandidateId: { not: null } },
      select: { skuId: true, matchDecision: true, comparable: true, combinationState: true },
      orderBy: { createdAt: "asc" }
    });
    assert.deepEqual(decisions.map((decision) => [
      decision.skuId,
      decision.matchDecision,
      decision.comparable,
      decision.combinationState
    ]), [
      ["sku-bundle-exact", "BUNDLE", true, "MATCHED"],
      ["sku-bundle-x2", "BUNDLE", true, "MISSING_OWN"],
      ["sku-bundle-two-cables", "BUNDLE", true, "MISSING_OWN"],
      ["sku-bundle-missing", "BUNDLE", true, "MISSING_OWN"],
      ["sku-bundle-extra", "BUNDLE", true, "MISSING_OWN"],
      ["sku-bundle-unstructured", "BUNDLE", true, "REVIEW"]
    ]);
  } finally {
    await prisma.monitoredModel.delete({ where: { id: model.id } });
    await prisma.bundle.delete({ where: { id: bundle.id } });
  }
});
