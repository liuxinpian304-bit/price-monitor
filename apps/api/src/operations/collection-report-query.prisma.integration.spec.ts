import "dotenv/config";

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { createPrismaClient } from "../database/prisma.service.ts";
import type { CollectionRunBusinessSkuRow } from "./collection-report-aggregation.ts";
import { CollectionReportQueryService, PrismaCollectionReportRepository } from "./collection-report-query.service.ts";

const prisma = createPrismaClient();
const prefix = `TASK14-REPORT-${process.pid}-${Date.now()}`;
const modelId = `${prefix}-model`;
const ownListingId = `${prefix}-own`;
const mainRunId = `${prefix}-run-204`;
const zeroBaselineRunId = `${prefix}-run-000`;

before(async () => {
  await prisma.$connect();
});

after(async () => {
  await prisma.monitoredModel.deleteMany({ where: { id: modelId } });
  await prisma.$disconnect();
});

test("bounds large report pages and keeps database-side filters and totals accurate", async () => {
  const existingRunCount = await prisma.collectionRun.count();
  await prisma.monitoredModel.create({
    data: {
      id: modelId,
      monitorCode: `${prefix}-7506`,
      brand: "Sony",
      standardModel: "MDR-7506",
      category: "headphones",
      searchQuery: "Sony MDR-7506",
      comparisonType: "BARE",
      owner: "task14-test"
    }
  });
  await prisma.ownListing.create({
    data: {
      id: ownListingId,
      monitoredModelId: modelId,
      platformItemId: "own-item",
      url: "https://example.invalid/own-item",
      skuText: "标准版"
    }
  });
  const scheduledBase = Date.UTC(2030, 0, 1, 0, 0, 0);
  await prisma.collectionRun.createMany({
    data: Array.from({ length: 205 }, (_, index) => ({
      id: `${prefix}-run-${String(index).padStart(3, "0")}`,
      monitoredModelId: modelId,
      providerKey: "task14-desktop-fixture",
      status: "PARTIAL_FAILED" as const,
      scheduledFor: new Date(scheduledBase + index * 1_000),
      claimedOwnListingIds: index === 0 || index === 204 ? [ownListingId] : [],
      searchLimit: 200,
      discoveredCount: 150,
      fetchedCount: 150,
      matchedCount: 120,
      failedCount: 30,
      incompleteCount: 30
    }))
  });
  const capturedAt = new Date("2030-01-01T01:00:00.000Z");
  await prisma.collectionSearchPosition.createMany({
    data: [
      ...Array.from({ length: 150 }, (_, index) => ({
        collectionRunId: mainRunId,
        rank: index + 1,
        platformItemId: `item-${index + 1}`,
        url: `https://example.invalid/items/${index + 1}`,
        shopName: "合成同行店",
        title: `Sony MDR-7506 fixture ${index + 1}`,
        displayPriceMinFen: 60_000 + index,
        displayPriceMaxFen: 70_000 + index,
        sponsored: false,
        capturedAt
      })),
      {
        collectionRunId: mainRunId,
        rank: 151,
        platformItemId: "item-1",
        url: "https://example.invalid/items/1",
        shopName: "合成同行店",
        title: "Sony MDR-7506 fixture duplicate rank",
        displayPriceMinFen: 60_000,
        displayPriceMaxFen: 70_000,
        sponsored: false,
        capturedAt
      }
    ]
  });
  await prisma.offerSnapshot.create({
    data: {
      id: `${prefix}-snapshot-own`,
      collectionRunId: mainRunId,
      ownListingId,
      platformItemId: "own-item",
      skuId: "own-standard",
      shopName: "星空乐器专营店",
      title: "Sony MDR-7506",
      skuText: "标准版",
      listPriceFen: 70_000,
      activityPriceFen: 70_000,
      payableFen: 70_000,
      priceConfidence: "CONFIRMED",
      stockState: "IN_STOCK",
      matchDecision: "BARE",
      comparable: true,
      matchConfidenceBps: 10_000,
      matchReasons: ["fixture exact own"],
      combinationSignature: "signature-standard",
      combinationLabel: "MDR-7506 标准版",
      combinationState: "OWN",
      combinationReasons: { ruleVersion: "sku-combination-v1", codes: [] },
      rawEvidence: {
        attributes: { 型号: "MDR-7506", 版本: "标准版" },
        components: [{
          role: "CORE",
          accessoryType: "HEADPHONES",
          brand: "Sony",
          modelOrName: "MDR-7506",
          quantity: 1
        }]
      },
      ingestionKey: `${prefix}-ingestion-own`,
      capturedAt
    }
  });
  await prisma.offerSnapshot.createMany({
    data: Array.from({ length: 220 }, (_, index) => {
      const exact = index < 120;
      const review = index >= 120 && index < 170;
      return {
        id: `${prefix}-snapshot-${String(index).padStart(3, "0")}`,
        collectionRunId: mainRunId,
        platformItemId: `item-${(index % 150) + 1}`,
        skuId: `sku-${index + 1}`,
        shopName: "合成同行店",
        title: exact ? "Sony MDR-7506" : review ? "Sony MDR-7506 待复核" : "Sony MDR-7506 二手",
        skuText: exact ? "标准版" : review ? "未知版本" : "二手",
        listPriceFen: exact ? (index % 2 === 0 ? 69_000 : 71_000) : 50_000,
        activityPriceFen: exact ? (index % 2 === 0 ? 69_000 : 71_000) : 50_000,
        payableFen: exact ? (index % 2 === 0 ? 69_000 : 71_000) : 50_000,
        priceConfidence: review ? "MANUAL_REVIEW" as const : "CONFIRMED" as const,
        stockState: exact ? "IN_STOCK" as const : "OUT_OF_STOCK" as const,
        matchDecision: exact ? "BARE" as const : review ? "MANUAL" as const : "REJECTED" as const,
        comparable: exact,
        matchConfidenceBps: exact ? 10_000 : review ? 5_000 : 0,
        matchReasons: [exact ? "fixture exact" : review ? "fixture review" : "fixture excluded"],
        combinationSignature: exact ? "signature-standard" : null,
        combinationLabel: exact ? "MDR-7506 标准版" : null,
        combinationState: exact ? "MATCHED" as const : review ? "REVIEW" as const : "EXCLUDED" as const,
        combinationReasons: {
          ruleVersion: "sku-combination-v1",
          codes: [exact ? "EXACT_SIGNATURE" : review ? "SKU_COMPONENTS_INCOMPLETE" : "PRODUCT_EXCLUDED"]
        },
        comparisonOwnSnapshotId: exact ? `${prefix}-snapshot-own` : null,
        rawEvidence: {
          attributes: { 型号: "MDR-7506", 版本: exact ? "标准版" : review ? "未知" : "二手" },
          components: exact ? [{
            role: "CORE",
            accessoryType: "HEADPHONES",
            brand: "Sony",
            modelOrName: "MDR-7506",
            quantity: 1
          }] : []
        },
        promotions: index === 0 ? [{
          kind: "COUPON",
          label: "公开券",
          amountFen: 1_000,
          thresholdFen: 60_000,
          audience: "PUBLIC",
          stackGroup: "shop-coupon",
          includedInActivityPrice: false,
          activityPriceInclusion: "EXCLUDED"
        }] : [],
        gifts: index === 0 ? [{ name: "音频线", quantity: 1 }] : [],
        ingestionKey: `${prefix}-ingestion-${index}`,
        capturedAt
      };
    })
  });
  await prisma.offerSnapshot.createMany({
    data: [
      {
        id: `${prefix}-corrupt-cross-signature`,
        collectionRunId: mainRunId,
        platformItemId: "item-1",
        skuId: "corrupt-cross-signature",
        shopName: "合成同行店",
        title: "Sony MDR-7506 corrupt cross signature",
        skuText: "标准版",
        listPriceFen: 60_000,
        activityPriceFen: 60_000,
        payableFen: 60_000,
        priceConfidence: "CONFIRMED" as const,
        stockState: "IN_STOCK" as const,
        matchDecision: "BARE" as const,
        comparable: true,
        matchConfidenceBps: 10_000,
        matchReasons: ["corrupt relation fixture"],
        combinationSignature: "signature-other",
        combinationLabel: "Other combination",
        combinationState: "MATCHED" as const,
        combinationReasons: { ruleVersion: "sku-combination-v1", codes: ["EXACT_SIGNATURE"] },
        comparisonOwnSnapshotId: `${prefix}-snapshot-own`,
        rawEvidence: { attributes: { 型号: "MDR-7506" }, components: [] },
        ingestionKey: `${prefix}-corrupt-cross-signature-ingestion`,
        capturedAt
      },
      {
        id: `${prefix}-corrupt-non-own`,
        collectionRunId: mainRunId,
        platformItemId: "item-2",
        skuId: "corrupt-non-own",
        shopName: "合成同行店",
        title: "Sony MDR-7506 corrupt non-own reference",
        skuText: "标准版",
        listPriceFen: 60_000,
        activityPriceFen: 60_000,
        payableFen: 60_000,
        priceConfidence: "CONFIRMED" as const,
        stockState: "IN_STOCK" as const,
        matchDecision: "BARE" as const,
        comparable: true,
        matchConfidenceBps: 10_000,
        matchReasons: ["corrupt relation fixture"],
        combinationSignature: "signature-standard",
        combinationLabel: "MDR-7506 标准版",
        combinationState: "MATCHED" as const,
        combinationReasons: { ruleVersion: "sku-combination-v1", codes: ["EXACT_SIGNATURE"] },
        comparisonOwnSnapshotId: `${prefix}-snapshot-001`,
        rawEvidence: { attributes: { 型号: "MDR-7506" }, components: [] },
        ingestionKey: `${prefix}-corrupt-non-own-ingestion`,
        capturedAt
      }
    ]
  });
  await prisma.offerSnapshot.createMany({
    data: [
      {
        id: `${prefix}-zero-own`,
        collectionRunId: zeroBaselineRunId,
        ownListingId,
        platformItemId: "zero-own-item",
        skuId: "zero-standard",
        shopName: "星空乐器专营店",
        title: "Zero baseline fixture",
        skuText: "标准版",
        listPriceFen: 0,
        activityPriceFen: 0,
        payableFen: 0,
        priceConfidence: "CONFIRMED",
        stockState: "IN_STOCK",
        matchDecision: "BARE",
        comparable: true,
        matchConfidenceBps: 10_000,
        matchReasons: ["fixture zero own"],
        combinationSignature: "signature-zero",
        combinationLabel: "Zero 标准版",
        combinationState: "OWN" as const,
        combinationReasons: { ruleVersion: "sku-combination-v1", codes: [] },
        ingestionKey: `${prefix}-zero-own-ingestion`,
        capturedAt
      },
      {
        id: `${prefix}-zero-competitor`,
        collectionRunId: zeroBaselineRunId,
        platformItemId: "zero-competitor-item",
        skuId: "zero-standard",
        shopName: "合成同行店",
        title: "Zero competitor fixture",
        skuText: "标准版",
        listPriceFen: 0,
        activityPriceFen: 0,
        payableFen: 0,
        priceConfidence: "CONFIRMED",
        stockState: "IN_STOCK",
        matchDecision: "BARE",
        comparable: true,
        matchConfidenceBps: 10_000,
        matchReasons: ["fixture zero competitor"],
        combinationSignature: "signature-zero",
        combinationLabel: "Zero 标准版",
        combinationState: "MATCHED" as const,
        combinationReasons: { ruleVersion: "sku-combination-v1", codes: ["EXACT_SIGNATURE"] },
        comparisonOwnSnapshotId: `${prefix}-zero-own`,
        ingestionKey: `${prefix}-zero-competitor-ingestion`,
        capturedAt
      }
    ]
  });
  await prisma.collectionRun.update({
    where: { id: zeroBaselineRunId },
    data: { ownBaselineSnapshotId: `${prefix}-zero-own` }
  });
  await prisma.collectionIssue.createMany({
    data: Array.from({ length: 140 }, (_, index) => ({
      collectionRunId: mainRunId,
      issueKey: `${prefix}-issue-${index}`,
      code: "SKU_ENUMERATION_INCOMPLETE",
      platformItemId: `item-${(index % 150) + 1}`,
      message: "sanitized fixture issue",
      capturedAt
    }))
  });

  const service = new CollectionReportQueryService(new PrismaCollectionReportRepository(prisma));
  const list = await service.listRuns({ page: 2, pageSize: 100 });
  const detail = await service.getRun(
    mainRunId,
    {
      source: "COMPETITOR",
      match: "EXACT",
      price: "LOWER",
      confidence: "CONFIRMED",
      combinationState: "MATCHED"
    },
    {
      positionPage: 2,
      positionPageSize: 40,
      issuePage: 3,
      issuePageSize: 20,
      skuPage: 2,
      skuPageSize: 25
    }
  );

  assert.equal(list.runs.length, 100);
  assert.equal(list.pagination.total, existingRunCount + 205);
  assert.equal(list.pagination.totalPages, Math.ceil((existingRunCount + 205) / 100));
  assert.ok(list.runs.every((run) => run.provider === "task14-desktop-fixture"));
  assert.ok(detail);
  assert.equal(detail.positions.length, 40);
  assert.equal(detail.positions[0]?.rank, 41);
  assert.equal(detail.pagination.positions.total, 151);
  assert.equal(detail.issues.length, 20);
  assert.equal(detail.pagination.issues.total, 140);
  assert.equal(detail.skus.length, 25);
  assert.equal(detail.pagination.skus.total, 60);
  assert.equal(detail.totalSkuCount, 223);
  assert.equal(detail.completion.label, "151 / 200，未完成");
  assert.deepEqual(detail.businessSummary, {
    distinctShopCount: 1,
    distinctItemCount: 150,
    skuCount: 222,
    matchedSkuCount: 120,
    confirmedLowCount: 60,
    missingCombinationCount: 0,
    reviewCount: 52,
    excludedCount: 50,
    ownConfiguredListingCount: 1,
    ownCollectedListingCount: 1,
    ownCatalogComplete: true
  });
  assert.equal(detail.priceBoard.shops[0]?.itemCount, 150);
  assert.equal(detail.priceBoard.shops[0]?.skuCount, 222);
  assert.equal(detail.confirmedLows.length, 60);
  assert.equal(detail.reviewRows.length, 52);
  const projectedFirst = detail.priceBoard.shops[0]?.items
    .find((item) => item.platformItemId === "item-1")?.skus
    .find((sku) => sku.id === `${prefix}-snapshot-000`);
  assert.deepEqual(projectedFirst?.ranks, [1, 151]);
  assert.equal(projectedFirst?.url, "https://example.invalid/items/1");
  assert.equal(projectedFirst?.prices.payableFen, 69_000);
  assert.equal(projectedFirst?.selectedOwnSnapshot?.prices.payableFen, 70_000);
  assert.equal(projectedFirst?.differenceFen, 1_000);
  assert.equal(projectedFirst?.components?.[0]?.role, "CORE");
  assert.equal(projectedFirst?.promotions[0]?.amountFen, 1_000);
  assert.deepEqual(projectedFirst?.gifts, [{ name: "音频线", quantity: 1 }]);
  for (const id of [`${prefix}-corrupt-cross-signature`, `${prefix}-corrupt-non-own`]) {
    const corrupt: CollectionRunBusinessSkuRow | undefined = detail.priceBoard.shops[0]?.items
      .flatMap((item) => item.skus)
      .find((sku) => sku.id === id);
    assert.equal(corrupt?.selectedOwnSnapshot, null);
    assert.equal(corrupt?.combination.state, "REVIEW");
    assert.ok(corrupt?.combination.reasons.includes("INVALID_COMPARISON_OWN_SNAPSHOT"));
  }
  assert.ok(detail.skus.every((sku) => sku.source === "COMPETITOR"
    && sku.match.category === "EXACT"
    && sku.comparison.state === "LOWER"
    && sku.combination.state === "MATCHED"
    && sku.confidence === "CONFIRMED"));

  const duplicateRankDetail = await service.getRun(
    mainRunId,
    { source: "COMPETITOR", match: "EXACT" },
    { skuPage: 1, skuPageSize: 100 }
  );
  assert.ok(duplicateRankDetail);
  assert.deepEqual(
    duplicateRankDetail.skus.find((sku) => sku.platformItemId === "item-1")?.ranks,
    [1, 151]
  );
  assert.deepEqual(
    duplicateRankDetail.priceBoard.shops[0]?.items.find((item) => item.platformItemId === "item-1")?.ranks,
    [1, 151]
  );

  const zeroBaselineDetail = await service.getRun(
    zeroBaselineRunId,
    { source: "COMPETITOR", price: "NOT_LOWER" }
  );
  assert.ok(zeroBaselineDetail);
  assert.equal(zeroBaselineDetail.pagination.skus.total, 1);
  assert.equal(zeroBaselineDetail.skus[0]?.comparison.state, "NOT_LOWER");
});
