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
  skuText?: string;
  components?: BundleComponentFixture[];
  priceConfidence?: "CONFIRMED" | "ESTIMATED" | "MANUAL_REVIEW";
  stockState?: "IN_STOCK" | "OUT_OF_STOCK" | "UNKNOWN";
}

interface BundleComponentFixture {
  accessoryType: string;
  brand: string | null;
  modelOrName: string;
  quantity: number;
}

function rawEvidence(
  skuText: string,
  components?: BundleComponentFixture[]
): Prisma.InputJsonObject {
  const jsonComponents = components?.map((component): Prisma.InputJsonObject => ({
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
      rawEvidence: rawEvidence(ownSkuText, input.ownComponents),
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
        rawEvidence: rawEvidence(skuText, price.components),
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
    searchLimit: unit.data.searchLimit,
    skuCount: unit.data.skuCount,
    issueCount: unit.data.issueCount,
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
    }]
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
      async () => restartedSender
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
    assert.equal((await service.evaluateRun(repeatedRun.id)).alerts.length, 0);
    assert.equal(await prisma.runAlertNotificationBatch.findUnique({
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
    assert.equal(await prisma.priceAlert.count({ where: { monitoredModelId: model.id } }), 3);

    const evaluatedRun = await prisma.collectionRun.findUniqueOrThrow({
      where: { id: firstRun.id },
      select: { ownBaselineSnapshotId: true }
    });
    assert.equal(evaluatedRun.ownBaselineSnapshotId, summaryWithAlerts.baseline?.snapshotId);

    const ambiguousSender = new AmbiguousSender();
    const ambiguousNotifier = new RunAlertNotifier(
      new PrismaRunAlertNotificationRepository(prisma),
      async () => ambiguousSender
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
      async () => sender
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
      async () => abandonedSender
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

test("rolls back the alert and notification batch on a pre-commit crash", async () => {
  const { model, run } = await seedEvaluationFixture("rollback", 7);
  const dedupKey = `task-3-rollback-${randomUUID()}`;
  const repository = new PrismaRunAlertRepository(prisma);

  try {
    await assert.rejects(
      repository.withEvaluation(run.id, async (unit) => {
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
  } finally {
    await prisma.monitoredModel.delete({ where: { id: model.id } });
  }
});

test("compares only exact structured bundle signatures after Prisma persistence", async () => {
  const suffix = randomUUID().replaceAll("-", "");
  const exactComponents: BundleComponentFixture[] = [
    { accessoryType: "耳机", brand: "Sony", modelOrName: "MDR-7506", quantity: 1 },
    { accessoryType: "转换线", brand: null, modelOrName: "C口转换线", quantity: 1 }
  ];
  const bundle = await prisma.bundle.create({
    data: {
      code: `T12-B-${suffix.slice(0, 20)}`,
      title: "MDR-7506 C口转换线套装",
      items: {
        create: exactComponents.map((component) => ({
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
            { accessoryType: "收纳", brand: null, modelOrName: "防尘收纳盒", quantity: 1 }
          ]
        },
        {
          key: "bundle-unstructured",
          payableFen: 64_000,
          skuText: "MDR-7506 + C口转换线套装"
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
        ["CONFIRMED_LOW", "C口转换线 + MDR-7506 套装"],
        ["MANUAL_REVIEW", "MDR-7506 + C口转换线 x2 套装"],
        ["MANUAL_REVIEW", "MDR-7506 + C口转换线2条 套装"],
        ["MANUAL_REVIEW", "MDR-7506 套装"],
        ["MANUAL_REVIEW", "MDR-7506 + C口转换线 + 防尘收纳盒套装"],
        ["MANUAL_REVIEW", "MDR-7506 + C口转换线套装"]
      ]
    );
    const decisions = await prisma.offerSnapshot.findMany({
      where: { collectionRunId: run.id, searchCandidateId: { not: null } },
      select: { skuId: true, matchDecision: true, comparable: true },
      orderBy: { createdAt: "asc" }
    });
    assert.deepEqual(decisions.map((decision) => [
      decision.skuId,
      decision.matchDecision,
      decision.comparable
    ]), [
      ["sku-bundle-exact", "BUNDLE", true],
      ["sku-bundle-x2", "MANUAL", false],
      ["sku-bundle-two-cables", "MANUAL", false],
      ["sku-bundle-missing", "MANUAL", false],
      ["sku-bundle-extra", "MANUAL", false],
      ["sku-bundle-unstructured", "MANUAL", false]
    ]);
  } finally {
    await prisma.monitoredModel.delete({ where: { id: model.id } });
    await prisma.bundle.delete({ where: { id: bundle.id } });
  }
});
