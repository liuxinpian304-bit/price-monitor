import "dotenv/config";

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { Prisma } from "../../../../generated/prisma/client.ts";
import type { CollectorReport } from "../../../../packages/contracts/src/index.ts";
import { CollectorAgentService } from "../collector-agent/collector-agent.service.ts";
import { PrismaCollectorAgentRepository } from "../collector-agent/prisma-collector-agent.repository.ts";
import { createCollectorToken } from "../collector-agent/collector-token.ts";
import { PrismaRunAlertNotificationRepository } from "../alerts/prisma-run-alert-notification.repository.ts";
import { PrismaRunAlertEvaluationRepository } from "../alerts/prisma-run-alert-evaluation.repository.ts";
import { RunAlertReconciler } from "../alerts/run-alert-reconciler.ts";
import { RunAlertNotifier } from "../alerts/run-alert-notifier.ts";
import type { WecomMarkdownSender } from "../alerts/wecom/wecom.client.ts";
import { createPrismaClient } from "../database/prisma.service.ts";
import { CollectionEvidenceStore } from "./collection-evidence-store.ts";
import { DesktopReportIngestionService } from "./desktop-report-ingestion.service.ts";
import { PrismaDesktopReportRepository } from "./prisma-desktop-report.repository.ts";
import { PrismaRunAlertRepository } from "./prisma-run-alert.repository.ts";
import type { RunAlertSummary } from "./run-alert.service.ts";

const prisma = createPrismaClient();
const evidenceRootTemporary = await mkdtemp(join(tmpdir(), "desktop-report-integration-"));
const evidenceRoot = await realpath(evidenceRootTemporary);
const evidenceStore = new CollectionEvidenceStore(evidenceRoot);

function evidence(bytes: Buffer): { bytes: Buffer; digest: string; key: string } {
  const digest = createHash("sha256").update(bytes).digest("hex");
  return { bytes, digest, key: `sha256:${digest}` };
}

function shanghaiOffset(value: string): string {
  const shifted = new Date(new Date(value).getTime() + 8 * 60 * 60 * 1_000).toISOString();
  return `${shifted.slice(0, -1)}+08:00`;
}

const firstEvidence = evidence(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 11, 12]));
const secondEvidence = evidence(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 21, 22]));

class AlwaysFailingSender implements WecomMarkdownSender {
  readonly messages: string[] = [];

  async sendMarkdown(message: string) {
    this.messages.push(message);
    throw new Error("private webhook failure");
  }
}

before(async () => {
  await prisma.$connect();
});

after(async () => {
  await prisma.$disconnect();
  await rm(evidenceRootTemporary, { recursive: true, force: true });
});

test("claim skips queued desktop runs without an active own listing", async () => {
  const suffix = randomUUID().replaceAll("-", "");
  const token = createCollectorToken();
  const modelIds: string[] = [];
  let agentId: string | undefined;

  try {
    const emptyModel = await prisma.monitoredModel.create({
      data: {
        monitorCode: `T11-E0-${suffix.slice(0, 17)}`,
        brand: "Sony",
        standardModel: "MDR-7506-empty",
        category: "headphones",
        searchQuery: "Sony MDR-7506 empty",
        comparisonType: "BARE",
        owner: "task-11-empty-claim"
      }
    });
    modelIds.push(emptyModel.id);
    const eligibleModel = await prisma.monitoredModel.create({
      data: {
        monitorCode: `T11-E1-${suffix.slice(0, 17)}`,
        brand: "Sony",
        standardModel: "MDR-7506-eligible",
        category: "headphones",
        searchQuery: "Sony MDR-7506 eligible",
        comparisonType: "BARE",
        owner: "task-11-empty-claim"
      }
    });
    modelIds.push(eligibleModel.id);
    const ownListing = await prisma.ownListing.create({
      data: {
        monitoredModelId: eligibleModel.id,
        platform: "TAOBAO",
        shopName: "Own Shop",
        platformItemId: `eligible-${suffix}`,
        url: `https://item.taobao.com/item.htm?id=eligible-${suffix}`,
        skuText: "Black"
      }
    });
    const agent = await prisma.collectorAgent.create({
      data: {
        name: `task-11-empty-claim-agent-${suffix}`,
        platform: "MACOS",
        tokenHash: token.hash,
        enabled: true
      }
    });
    agentId = agent.id;
    const baseTime = Date.now() - 60_000;
    const emptyRun = await prisma.collectionRun.create({
      data: {
        monitoredModelId: emptyModel.id,
        providerKey: "taobao-desktop",
        status: "QUEUED",
        scheduledFor: new Date(baseTime),
        collectorAgentId: agent.id,
        searchLimit: 50
      }
    });
    const eligibleRun = await prisma.collectionRun.create({
      data: {
        monitoredModelId: eligibleModel.id,
        providerKey: "taobao-desktop",
        status: "QUEUED",
        scheduledFor: new Date(baseTime + 1),
        collectorAgentId: agent.id,
        searchLimit: 50
      }
    });

    const claimed = await new PrismaCollectorAgentRepository(prisma).claimNext(agent.id, {
      appVersion: "2.4.5",
      capabilities: ["accessibility"]
    });

    assert.equal(claimed?.runId, eligibleRun.id);
    assert.deepEqual(claimed?.ownListings.map((listing) => listing.id), [ownListing.id]);
    assert.deepEqual(await prisma.collectionRun.findUniqueOrThrow({
      where: { id: emptyRun.id },
      select: { status: true, claimedOwnListingIds: true }
    }), { status: "QUEUED", claimedOwnListingIds: [] });
  } finally {
    if (modelIds.length > 0) {
      await prisma.collectionRun.deleteMany({ where: { monitoredModelId: { in: modelIds } } });
      await prisma.monitoredModel.deleteMany({ where: { id: { in: modelIds } } });
    }
    if (agentId) await prisma.collectorAgent.deleteMany({ where: { id: agentId } });
  }
});

test("transactionally ingests one concurrent report history and returns its original summary", async (context) => {
  const suffix = randomUUID().replaceAll("-", "");
  const token = createCollectorToken();
  let modelId: string | undefined;
  let agentId: string | undefined;
  let runId: string | undefined;

  try {
    const model = await prisma.monitoredModel.create({
      data: {
        monitorCode: `T11-${suffix.slice(0, 20)}`,
        brand: "Sony",
        standardModel: "MDR-7506",
        category: "headphones",
        searchQuery: "Sony MDR-7506",
        comparisonType: "BARE",
        owner: "task-11-integration"
      }
    });
    modelId = model.id;
    const ownListing = await prisma.ownListing.create({
      data: {
        monitoredModelId: model.id,
        platform: "TAOBAO",
        shopName: "Own Shop",
        platformItemId: `own-${suffix}`,
        url: `https://item.taobao.com/item.htm?id=own-${suffix}`,
        skuText: "Black"
      }
    });
    await prisma.ownListing.create({
      data: {
        monitoredModelId: model.id,
        platform: "TAOBAO",
        shopName: "Inactive Own Shop",
        platformItemId: `inactive-${suffix}`,
        url: `https://item.taobao.com/item.htm?id=inactive-${suffix}`,
        skuText: "Inactive",
        active: false
      }
    });
    const agent = await prisma.collectorAgent.create({
      data: {
        name: `task-11-agent-${suffix}`,
        platform: "MACOS",
        tokenHash: token.hash,
        enabled: true,
        appVersion: "2.4.5"
      }
    });
    agentId = agent.id;
    const run = await prisma.collectionRun.create({
      data: {
        monitoredModelId: model.id,
        providerKey: "taobao-desktop",
        status: "QUEUED",
        scheduledFor: new Date(0),
        collectorAgentId: agent.id,
        searchLimit: 50
      }
    });
    runId = run.id;

    const collectorRepository = new PrismaCollectorAgentRepository(prisma);
    const claimedJob = await collectorRepository.claimNext(agent.id, {
      appVersion: "2.4.5",
      capabilities: ["accessibility"]
    });
    assert.equal(claimedJob?.runId, run.id);
    assert.deepEqual(claimedJob?.ownListings.map((listing) => listing.id), [ownListing.id]);
    await prisma.ownListing.update({ where: { id: ownListing.id }, data: { active: false } });

    await evidenceStore.put(run.id, firstEvidence.digest, firstEvidence.bytes);
    await evidenceStore.put(run.id, secondEvidence.digest, secondEvidence.bytes);

    const ownItemId = `own-${suffix}`;
    const competitorItemId = `competitor-${suffix}`;
    const unavailableItemId = `unavailable-${suffix}`;
    const positions = Array.from({ length: 50 }, (_, index) => {
      const rank = index + 1;
      const own = rank === 1;
      const unavailable = rank >= 49;
      const platformItemId = own ? ownItemId : unavailable ? unavailableItemId : competitorItemId;
      return {
        rank,
        platformItemId,
        url: `https://${own ? "item.taobao.com" : "detail.tmall.com"}/item.htm?id=${platformItemId}`,
        shopName: own ? "Own Shop" : unavailable ? "Unavailable Shop" : "Competitor Shop",
        title: own ? "Sony MDR-7506 own" : unavailable
          ? "Sony MDR-7506 unavailable"
          : "Sony MDR-7506 competitor",
        displayPriceMinFen: own ? 69_800 : unavailable ? 64_800 : 65_800,
        displayPriceMaxFen: own ? 69_800 : unavailable ? 64_800 : 65_800,
        sponsored: rank === 2,
        capturedAt: shanghaiOffset(new Date(Date.UTC(2026, 7, 24, 1, 30, rank)).toISOString())
      };
    });

    const report: CollectorReport = {
      schemaVersion: 1,
      runId: run.id,
      collectorId: agent.id,
      appVersion: "2.4.5",
      startedAt: "2026-08-24T09:30:00.000+08:00",
      completedAt: "2026-08-24T09:40:00.000+08:00",
      status: "PARTIAL_FAILED",
      searchLimit: 50,
      positions,
      ownItems: [{
        ownListingId: ownListing.id,
        platformItemId: ownItemId,
        url: `https://item.taobao.com/item.htm?id=${ownItemId}`,
        shopName: "A user-editable shop value",
        title: "Sony MDR-7506 own",
        searchRanks: [1],
        skus: [
          {
            skuId: "own-black",
            label: "Black",
            attributes: { color: "Black", package: "Bare" },
            stockState: "IN_STOCK",
            listPriceFen: 72_800,
            activityPriceFen: 69_800,
            couponDiscountFen: 1_000,
            fullReductionFen: 500,
            directDiscountFen: 0,
            promotions: [{
              kind: "COUPON",
              label: "Public coupon",
              amountFen: 1_000,
              thresholdFen: 60_000,
              audience: "PUBLIC",
              stackGroup: "shop-coupon",
              includedInActivityPrice: false,
              activityPriceInclusion: "EXCLUDED"
            }, {
              kind: "FULL_REDUCTION",
              label: "Public full reduction",
              amountFen: 500,
              thresholdFen: 60_000,
              audience: "PUBLIC",
              stackGroup: "platform-full-reduction",
              includedInActivityPrice: false,
              activityPriceInclusion: "EXCLUDED"
            }],
            mandatoryFeeFen: 100,
            priceConfidence: "CONFIRMED",
            payableFen: 68_400,
            capturedAt: "2026-08-24T09:32:00.000+08:00",
            evidenceKey: firstEvidence.key
          },
          {
            skuId: "own-white",
            label: "White",
            attributes: { color: "White", package: "Bare" },
            stockState: "UNKNOWN",
            listPriceFen: 72_800,
            activityPriceFen: 70_800,
            couponDiscountFen: 0,
            fullReductionFen: 0,
            directDiscountFen: 0,
            promotions: [],
            mandatoryFeeFen: 0,
            priceConfidence: "ESTIMATED",
            payableFen: 70_800,
            capturedAt: "2026-08-24T09:32:30.000+08:00",
            evidenceKey: null
          }
        ]
      }],
      competitorItems: [{
        platformItemId: competitorItemId,
        url: `https://detail.tmall.com/item.htm?id=${competitorItemId}`,
        shopName: "Competitor Shop",
        title: "Sony MDR-7506 competitor",
        searchRanks: Array.from({ length: 47 }, (_, index) => index + 2),
        skus: [
          {
            skuId: "competitor-black",
            label: "Black",
            attributes: { color: "Black", package: "Bare" },
            stockState: "IN_STOCK",
            listPriceFen: 69_800,
            activityPriceFen: 65_800,
            couponDiscountFen: 2_000,
            fullReductionFen: 1_000,
            directDiscountFen: 0,
            promotions: [{
              kind: "COUPON",
              label: "Public coupon",
              amountFen: 2_000,
              thresholdFen: 60_000,
              audience: "PUBLIC",
              stackGroup: "shop-coupon",
              includedInActivityPrice: false,
              activityPriceInclusion: "EXCLUDED"
            }, {
              kind: "FULL_REDUCTION",
              label: "Public full reduction",
              amountFen: 1_000,
              thresholdFen: 65_000,
              audience: "PUBLIC",
              stackGroup: "platform-full-reduction",
              includedInActivityPrice: false,
              activityPriceInclusion: "EXCLUDED"
            }],
            mandatoryFeeFen: 0,
            priceConfidence: "CONFIRMED",
            payableFen: 62_800,
            capturedAt: "2026-08-24T09:33:00.000+08:00",
            evidenceKey: secondEvidence.key
          },
          {
            skuId: "competitor-white",
            label: "White",
            attributes: { color: "White", package: "Bare" },
            stockState: "IN_STOCK",
            listPriceFen: 70_800,
            activityPriceFen: 66_800,
            couponDiscountFen: 1_000,
            fullReductionFen: 0,
            directDiscountFen: 0,
            promotions: [{
              kind: "COUPON",
              label: "Public coupon",
              amountFen: 1_000,
              thresholdFen: 60_000,
              audience: "PUBLIC",
              stackGroup: "shop-coupon",
              includedInActivityPrice: false,
              activityPriceInclusion: "EXCLUDED"
            }],
            mandatoryFeeFen: 0,
            priceConfidence: "CONFIRMED",
            payableFen: 65_800,
            capturedAt: "2026-08-24T09:33:30.000+08:00",
            evidenceKey: null
          },
          {
            skuId: "competitor-bundle",
            label: "Bundle",
            attributes: { package: "Bundle" },
            stockState: "OUT_OF_STOCK",
            listPriceFen: 80_000,
            activityPriceFen: 75_000,
            couponDiscountFen: 0,
            fullReductionFen: 0,
            directDiscountFen: 0,
            promotions: [],
            mandatoryFeeFen: 0,
            priceConfidence: "MANUAL_REVIEW",
            payableFen: null,
            capturedAt: "2026-08-24T09:34:00.000+08:00",
            evidenceKey: null
          },
          {
            skuId: "competitor-cable",
            label: "Cable",
            attributes: { package: "Cable" },
            stockState: "IN_STOCK",
            listPriceFen: 10_000,
            activityPriceFen: 9_000,
            couponDiscountFen: 0,
            fullReductionFen: 0,
            directDiscountFen: 0,
            promotions: [],
            mandatoryFeeFen: 0,
            priceConfidence: "ESTIMATED",
            payableFen: 9_000,
            capturedAt: "2026-08-24T09:34:30.000+08:00",
            evidenceKey: null
          }
        ]
      }, {
        platformItemId: unavailableItemId,
        url: `https://detail.tmall.com/item.htm?id=${unavailableItemId}`,
        shopName: "Unavailable Shop",
        title: "Sony MDR-7506 unavailable",
        searchRanks: [49, 50],
        skus: []
      }],
      issues: [
        {
          code: "PRICE_UNSTABLE",
          message: "Public price did not stabilize",
          platformItemId: competitorItemId,
          skuId: "competitor-cable",
          evidenceKey: secondEvidence.key,
          capturedAt: "2026-08-24T09:35:00.000+08:00"
        },
        {
          code: "ITEM_UNAVAILABLE",
          message: "Item became unavailable",
          platformItemId: unavailableItemId,
          capturedAt: "2026-08-24T09:35:30.000+08:00"
        }
      ]
    };

    const repository = new PrismaDesktopReportRepository(prisma);
    assert.deepEqual((await repository.inspectRun(agent.id, run.id))?.ownListingIds, [ownListing.id]);
    const service = new DesktopReportIngestionService(
      new CollectorAgentService(new PrismaCollectorAgentRepository(prisma)),
      repository,
      evidenceStore
    );
    const [first, concurrentRepeat] = await Promise.all([
      service.ingest(token.plaintext, report),
      service.ingest(token.plaintext, structuredClone(report))
    ]);
    const sequentialRepeat = await service.ingest(token.plaintext, structuredClone(report));

    assert.deepEqual(concurrentRepeat, first);
    assert.deepEqual(sequentialRepeat, first);

    const immutableSummary: RunAlertSummary = {
      runId: run.id,
      monitoredModelId: model.id,
      brand: "Sony",
      standardModel: "MDR-7506",
      comparisonType: "BARE",
      owner: "task-12-ingestion-retry",
      completedAt: new Date(report.completedAt),
      checkedItemCount: 1,
      positionCount: 1,
      shopCount: 1,
      searchLimit: 50,
      skuCount: 6,
      issueCount: 2,
      reviewCount: 0,
      reportUrl: `https://monitor.example.test/collection-runs/${run.id}`,
      baseline: null,
      systemIssue: "OWN_BASELINE_MISSING",
      alerts: [],
      missingOwnGroups: []
    };
    const failingSender = new AlwaysFailingSender();
    const notificationRepository = new PrismaRunAlertNotificationRepository(prisma);
    const notifier = new RunAlertNotifier(
      notificationRepository,
      async () => failingSender
    );
    const evaluator = {
      async evaluateRun(runId: string) {
        return new PrismaRunAlertRepository(prisma).withEvaluation(runId, async (unit) => {
          await unit.ensureNotificationBatch(immutableSummary);
          return structuredClone(immutableSummary);
        });
      }
    };
    const reconciler = new RunAlertReconciler(
      new PrismaRunAlertEvaluationRepository(prisma),
      evaluator,
      notifier,
      notificationRepository
    );
    const replayService = new DesktopReportIngestionService(
      new CollectorAgentService(new PrismaCollectorAgentRepository(prisma)),
      repository,
      evidenceStore,
      reconciler
    );
    assert.deepEqual(await replayService.ingest(token.plaintext, structuredClone(report)), first);
    const restartedReconciler = new RunAlertReconciler(
      new PrismaRunAlertEvaluationRepository(prisma),
      evaluator,
      notifier,
      notificationRepository
    );
    await restartedReconciler.reconcilePending();
    assert.deepEqual(await replayService.ingest(token.plaintext, structuredClone(report)), first);
    assert.equal(failingSender.messages.length, 2);
    assert.equal(failingSender.messages[0], failingSender.messages[1]);
    const exhaustedBatch = await prisma.runAlertNotificationBatch.findUniqueOrThrow({
      where: { collectionRunId: run.id }
    });
    assert.equal(exhaustedBatch.state, "FAILED");
    assert.equal(exhaustedBatch.notificationAttempts, 2);

    assert.deepEqual({
      runId: first.runId,
      status: first.status,
      positionCount: first.positionCount,
      uniqueItemCount: first.uniqueItemCount,
      skuCount: first.skuCount,
      issueCount: first.issueCount
    }, {
      runId: run.id,
      status: "PARTIAL_FAILED",
      positionCount: 50,
      uniqueItemCount: 3,
      skuCount: 6,
      issueCount: 2
    });

    const storedRun = await prisma.collectionRun.findUniqueOrThrow({ where: { id: run.id } });
    assert.deepEqual({
      status: storedRun.status,
      searchedCount: storedRun.searchedCount,
      fetchedCount: storedRun.fetchedCount,
      matchedCount: storedRun.matchedCount,
      failedCount: storedRun.failedCount,
      discoveredCount: storedRun.discoveredCount,
      skuCount: storedRun.skuCount,
      incompleteCount: storedRun.incompleteCount,
      finishedAt: storedRun.finishedAt?.toISOString()
    }, {
      status: "PARTIAL_FAILED",
      searchedCount: 50,
      fetchedCount: 3,
      matchedCount: 0,
      failedCount: 2,
      discoveredCount: 50,
      skuCount: 6,
      incompleteCount: 2,
      finishedAt: new Date(report.completedAt).toISOString()
    });
    assert.deepEqual(Reflect.get(storedRun, "claimedOwnListingIds"), [ownListing.id]);
    assert.match(storedRun.desktopReportDigest ?? "", /^sha256:[0-9a-f]{64}$/);
    assert.deepEqual(storedRun.desktopIngestionSummary, first);

    assert.equal(await prisma.collectionSearchPosition.count({ where: { collectionRunId: run.id } }), 50);
    assert.equal(await prisma.searchCandidate.count({
      where: { monitoredModelId: model.id, providerKey: "taobao-desktop", platformItemId: competitorItemId }
    }), 1);
    assert.equal(await prisma.offerSnapshot.count({ where: { collectionRunId: run.id } }), 6);
    assert.equal(await prisma.collectionIssue.count({ where: { collectionRunId: run.id } }), 2);

    const snapshots = await prisma.offerSnapshot.findMany({ where: { collectionRunId: run.id } });
    const ownSnapshots = snapshots.filter((snapshot) => snapshot.ownListingId === ownListing.id);
    const competitorSnapshots = snapshots.filter((snapshot) => snapshot.searchCandidateId !== null);
    assert.equal(ownSnapshots.length, 2);
    assert.equal(competitorSnapshots.length, 4);
    assert.deepEqual(new Set(first.ownSnapshotIds), new Set(ownSnapshots.map((snapshot) => snapshot.id)));
    assert.deepEqual(
      new Set(first.competitorSnapshotIds),
      new Set(competitorSnapshots.map((snapshot) => snapshot.id))
    );

    const ownBlack = snapshots.find((snapshot) => snapshot.skuId === "own-black")!;
    assert.deepEqual({
      ownListingId: ownBlack.ownListingId,
      searchCandidateId: ownBlack.searchCandidateId,
      listPriceFen: ownBlack.listPriceFen,
      activityPriceFen: ownBlack.activityPriceFen,
      couponDiscountFen: ownBlack.couponDiscountFen,
      fullReductionFen: ownBlack.fullReductionFen,
      directDiscountFen: ownBlack.directDiscountFen,
      mandatoryFeeFen: ownBlack.mandatoryFeeFen,
      publicDiscountFen: ownBlack.publicDiscountFen,
      payableFen: ownBlack.payableFen,
      priceConfidence: ownBlack.priceConfidence,
      evidenceKey: ownBlack.evidenceKey
    }, {
      ownListingId: ownListing.id,
      searchCandidateId: null,
      listPriceFen: 72_800,
      activityPriceFen: 69_800,
      couponDiscountFen: 1_000,
      fullReductionFen: 500,
      directDiscountFen: 0,
      mandatoryFeeFen: 100,
      publicDiscountFen: 1_500,
      payableFen: 68_400,
      priceConfidence: "CONFIRMED",
      evidenceKey: firstEvidence.key
    });

    const competitorBlack = snapshots.find((snapshot) => snapshot.skuId === "competitor-black")!;
    assert.equal(competitorBlack.ownListingId, null);
    assert.notEqual(competitorBlack.searchCandidateId, null);
    assert.equal(competitorBlack.evidenceKey, secondEvidence.key);
    assert.equal(competitorBlack.priceConfidence, "CONFIRMED");
    assert.deepEqual(competitorBlack.rawEvidence, {
      source: "taobao-desktop",
      attributes: { color: "Black", package: "Bare" }
    });

    const issue = await prisma.collectionIssue.findFirstOrThrow({
      where: { collectionRunId: run.id, code: "PRICE_UNSTABLE" }
    });
    assert.equal(issue.evidenceKey, secondEvidence.key);
    assert.equal(issue.message, "Public price did not stabilize");

    await context.test("rejects every replay when a terminal run has no durable receipt", async () => {
      const historyCounts = {
        positions: await prisma.collectionSearchPosition.count({ where: { collectionRunId: run.id } }),
        snapshots: await prisma.offerSnapshot.count({ where: { collectionRunId: run.id } }),
        issues: await prisma.collectionIssue.count({ where: { collectionRunId: run.id } })
      };
      await prisma.collectionRun.update({
        where: { id: run.id },
        data: { desktopReportDigest: null, desktopIngestionSummary: Prisma.JsonNull }
      });

      for (const entry of [
        { name: "identical", mutate: (_candidate: CollectorReport) => undefined },
        {
          name: "appVersion",
          mutate: (candidate: CollectorReport) => { candidate.appVersion = "2.4.6"; }
        },
        {
          name: "URL",
          mutate: (candidate: CollectorReport) => {
            candidate.ownItems[0]!.url = `${candidate.ownItems[0]!.url}&source=legacy`;
          }
        },
        {
          name: "searchRanks",
          mutate: (candidate: CollectorReport) => { candidate.competitorItems[0]!.searchRanks.reverse(); }
        },
        {
          name: "zero-SKU metadata",
          mutate: (candidate: CollectorReport) => {
            candidate.competitorItems[1]!.title = "Changed unavailable title";
          }
        }
      ]) {
        const candidate = structuredClone(report);
        entry.mutate(candidate);
        await assert.rejects(
          () => service.ingest(token.plaintext, candidate),
          (error) => error instanceof Error && error.name === "DesktopReportConflictError",
          entry.name
        );
      }

      const receiptless = await prisma.collectionRun.findUniqueOrThrow({ where: { id: run.id } });
      assert.equal(receiptless.desktopReportDigest, null);
      assert.equal(receiptless.desktopIngestionSummary, null);
      assert.deepEqual({
        positions: await prisma.collectionSearchPosition.count({ where: { collectionRunId: run.id } }),
        snapshots: await prisma.offerSnapshot.count({ where: { collectionRunId: run.id } }),
        issues: await prisma.collectionIssue.count({ where: { collectionRunId: run.id } })
      }, historyCounts);

      await prisma.collectionRun.update({
        where: { id: run.id },
        data: { desktopIngestionSummary: first as unknown as Prisma.InputJsonValue }
      });
      await assert.rejects(
        () => service.ingest(token.plaintext, structuredClone(report)),
        (error) => error instanceof Error && error.name === "DesktopReportConflictError"
      );
      assert.equal((await prisma.collectionRun.findUniqueOrThrow({ where: { id: run.id } }))
        .desktopReportDigest, null);

      await prisma.collectionRun.update({
        where: { id: run.id },
        data: {
          desktopReportDigest: storedRun.desktopReportDigest,
          desktopIngestionSummary: Prisma.JsonNull
        }
      });
      await assert.rejects(
        () => service.ingest(token.plaintext, structuredClone(report)),
        (error) => error instanceof Error && error.name === "DesktopReportConflictError"
      );
      assert.equal((await prisma.collectionRun.findUniqueOrThrow({ where: { id: run.id } }))
        .desktopIngestionSummary, null);

      await prisma.collectionRun.update({
        where: { id: run.id },
        data: {
          desktopReportDigest: storedRun.desktopReportDigest,
          desktopIngestionSummary: first as unknown as Prisma.InputJsonValue
        }
      });
    });

    await context.test("normalizes equivalent timestamps and object key order for replay", async () => {
      const equivalent = structuredClone(report);
      equivalent.startedAt = new Date(equivalent.startedAt).toISOString();
      equivalent.completedAt = new Date(equivalent.completedAt).toISOString();
      for (const position of equivalent.positions) {
        position.capturedAt = new Date(position.capturedAt).toISOString();
      }
      for (const item of [...equivalent.ownItems, ...equivalent.competitorItems]) {
        for (const sku of item.skus) {
          sku.capturedAt = new Date(sku.capturedAt).toISOString();
          sku.attributes = Object.fromEntries(Object.entries(sku.attributes).reverse());
        }
      }
      for (const entry of equivalent.issues) {
        entry.capturedAt = new Date(entry.capturedAt).toISOString();
      }

      assert.deepEqual(await service.ingest(token.plaintext, equivalent), first);
    });

    for (const entry of [
      {
        name: "rejects a changed appVersion on terminal replay",
        mutate: (candidate: CollectorReport) => { candidate.appVersion = "2.4.6"; }
      },
      {
        name: "rejects a changed URL on terminal replay",
        mutate: (candidate: CollectorReport) => {
          candidate.ownItems[0]!.url = `${candidate.ownItems[0]!.url}&source=replay`;
        }
      },
      {
        name: "rejects changed zero-SKU item metadata on terminal replay",
        mutate: (candidate: CollectorReport) => {
          candidate.competitorItems[1]!.title = "Changed unavailable title";
          candidate.competitorItems[1]!.searchRanks.reverse();
        }
      },
      {
        name: "rejects a changed evidence key before checking its bytes",
        mutate: (candidate: CollectorReport) => {
          candidate.ownItems[0]!.skus[0]!.evidenceKey = `sha256:${"f".repeat(64)}`;
        }
      }
    ]) {
      await context.test(entry.name, async () => {
        const changed = structuredClone(report);
        entry.mutate(changed);
        await assert.rejects(
          () => service.ingest(token.plaintext, changed),
          (error) => error instanceof Error && error.name === "DesktopReportConflictError"
        );
      });
    }

    await context.test("returns the durable original summary after later server-side history", async () => {
      const serverIssueKey = `sha256:${createHash("sha256").update(`server:${suffix}`).digest("hex")}`;
      await prisma.collectionIssue.create({
        data: {
          collectionRunId: run.id,
          issueKey: serverIssueKey,
          code: "OWN_BASELINE_MISSING",
          message: "Server-side baseline evaluation",
          capturedAt: new Date(report.completedAt)
        }
      });
      try {
        assert.deepEqual(await service.ingest(token.plaintext, structuredClone(report)), first);
      } finally {
        await prisma.collectionIssue.deleteMany({ where: { issueKey: serverIssueKey } });
      }
    });
  } finally {
    if (runId) await prisma.collectionRun.deleteMany({ where: { id: runId } });
    if (modelId) await prisma.monitoredModel.deleteMany({ where: { id: modelId } });
    if (agentId) await prisma.collectorAgent.deleteMany({ where: { id: agentId } });
  }
});

test("serializes evidence publication with concurrent terminal run transitions", async () => {
  const suffix = randomUUID().replaceAll("-", "");
  const token = createCollectorToken();
  let modelId: string | undefined;
  let agentId: string | undefined;
  let runId: string | undefined;

  try {
    const model = await prisma.monitoredModel.create({
      data: {
        monitorCode: `T11-E-${suffix.slice(0, 18)}`,
        brand: "Sony",
        standardModel: "MDR-7506",
        category: "headphones",
        searchQuery: "Sony MDR-7506",
        comparisonType: "BARE",
        owner: "task-11-evidence-lock"
      }
    });
    modelId = model.id;
    const agent = await prisma.collectorAgent.create({
      data: {
        name: `task-11-evidence-agent-${suffix}`,
        platform: "MACOS",
        tokenHash: token.hash,
        enabled: true,
        appVersion: "2.4.5"
      }
    });
    agentId = agent.id;
    const run = await prisma.collectionRun.create({
      data: {
        monitoredModelId: model.id,
        providerKey: "taobao-desktop",
        status: "RUNNING",
        scheduledFor: new Date(Number.parseInt(suffix.slice(0, 10), 16)),
        collectorAgentId: agent.id,
        claimedAt: new Date(),
        startedAt: new Date(),
        searchLimit: 1
      }
    });
    runId = run.id;

    const store = new CollectionEvidenceStore(evidenceRoot);
    const originalPut = store.put.bind(store);
    let enteredPut!: () => void;
    let releasePut!: () => void;
    const putEntered = new Promise<void>((resolve) => { enteredPut = resolve; });
    const putReleased = new Promise<void>((resolve) => { releasePut = resolve; });
    store.put = async (...arguments_: Parameters<CollectionEvidenceStore["put"]>) => {
      enteredPut();
      await putReleased;
      return originalPut(...arguments_);
    };

    const service = new DesktopReportIngestionService(
      new CollectorAgentService(new PrismaCollectorAgentRepository(prisma)),
      new PrismaDesktopReportRepository(prisma),
      store
    );
    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 31, 32]);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const upload = service.uploadEvidence(token.plaintext, run.id, digest, bytes);
    await putEntered;

    let transitionSettled = false;
    const transition = prisma.collectionRun.update({
      where: { id: run.id },
      data: { status: "FAILED", finishedAt: new Date() }
    }).finally(() => { transitionSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(transitionSettled, false);

    releasePut();
    assert.equal((await upload).created, true);
    await transition;
    assert.equal((await prisma.collectionRun.findUniqueOrThrow({ where: { id: run.id } })).status, "FAILED");

    assert.equal((await service.uploadEvidence(token.plaintext, run.id, digest, bytes)).created, false);

    const otherBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 41, 42]);
    const otherDigest = createHash("sha256").update(otherBytes).digest("hex");
    await assert.rejects(
      () => service.uploadEvidence(token.plaintext, run.id, otherDigest, otherBytes),
      (error) => error instanceof Error && error.name === "DesktopReportConflictError"
    );
    assert.equal(await store.has(run.id, `sha256:${otherDigest}`), false);
  } finally {
    if (runId) await prisma.collectionRun.deleteMany({ where: { id: runId } });
    if (modelId) await prisma.monitoredModel.deleteMany({ where: { id: modelId } });
    if (agentId) await prisma.collectorAgent.deleteMany({ where: { id: agentId } });
  }
});
