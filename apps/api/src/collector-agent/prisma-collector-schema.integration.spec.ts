import "dotenv/config";

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { createPrismaClient } from "../database/prisma.service.ts";

const prisma = createPrismaClient();
const testPrefix = `TASK14-SCHEMA-${process.pid}-${Date.now()}`;

async function clearData(): Promise<void> {
  if (runId) {
    await prisma.offerSnapshot.deleteMany({ where: { collectionRunId: runId } });
    await prisma.collectionSearchPosition.deleteMany({ where: { collectionRunId: runId } });
    await prisma.collectionIssue.deleteMany({ where: { collectionRunId: runId } });
    await prisma.collectionRun.deleteMany({ where: { id: runId } });
  }
  if (agentId) await prisma.collectorAgent.deleteMany({ where: { id: agentId } });
  if (candidateId) await prisma.searchCandidate.deleteMany({ where: { id: candidateId } });
  if (monitoredModelId) await prisma.monitoredModel.deleteMany({ where: { id: monitoredModelId } });
}

let monitoredModelId: string | undefined;
let candidateId: string | undefined;
let agentId: string | undefined;
let runId: string | undefined;

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === "object" && error !== null && Reflect.get(error, "code") === "P2002";
}

before(async () => {
  await prisma.$connect();
});

after(async () => {
  await clearData();
  await prisma.$disconnect();
});

test("persists desktop collector agents, positions, SKU confidence, and issues", async () => {
  const monitoredModel = await prisma.monitoredModel.create({
    data: {
      monitorCode: `${testPrefix}-7506`,
      brand: "Sony",
      standardModel: "MDR-7506",
      category: "headphones",
      searchQuery: "Sony MDR-7506",
      comparisonType: "BARE",
      owner: "collector-test"
    }
  });
  monitoredModelId = monitoredModel.id;
  const candidate = await prisma.searchCandidate.create({
    data: {
      monitoredModelId: monitoredModel.id,
      providerKey: "desktop-taobao",
      platformItemId: "item-1",
      url: "https://item.taobao.com/item.htm?id=item-1",
      shopName: "同行音频店",
      title: "索尼 7506"
    }
  });
  candidateId = candidate.id;
  const agent = await prisma.collectorAgent.create({
    data: {
      name: `${testPrefix}-mac-studio-1`,
      platform: "MACOS",
      tokenHash: `${testPrefix}-token`,
      enabled: true,
      appVersion: "2.4.5"
    }
  });
  agentId = agent.id;
  const run = await prisma.collectionRun.create({
    data: {
      monitoredModelId: monitoredModel.id,
      providerKey: "desktop-taobao",
      status: "QUEUED",
      scheduledFor: new Date("2026-08-24T01:30:00.000Z"),
      collectorAgentId: agent.id
    }
  });
  runId = run.id;
  const firstPosition = {
    collectionRunId: run.id,
    rank: 1,
    platformItemId: "item-1",
    url: "https://item.taobao.com/item.htm?id=item-1",
    shopName: "同行音频店",
    title: "索尼 7506",
    displayPriceMinFen: 65_800,
    displayPriceMaxFen: 65_800,
    sponsored: false,
    capturedAt: new Date("2026-08-24T01:30:00.000Z")
  };

  await prisma.collectionSearchPosition.create({ data: firstPosition });
  await prisma.collectionSearchPosition.create({
    data: {
      ...firstPosition,
      rank: 2,
      platformItemId: "item-2",
      url: "https://item.taobao.com/item.htm?id=item-2",
      title: "索尼 7506 专业监听耳机"
    }
  });

  const firstSnapshot = {
    collectionRunId: run.id,
    searchCandidateId: candidate.id,
    platformItemId: candidate.platformItemId,
    skuId: "black",
    shopName: candidate.shopName,
    title: candidate.title,
    skuText: "黑色",
    listPriceFen: 69_800,
    activityPriceFen: 65_800,
    couponDiscountFen: 2_000,
    fullReductionFen: 1_000,
    directDiscountFen: 0,
    mandatoryFeeFen: 0,
    payableFen: 62_800,
    priceConfidence: "CONFIRMED" as const,
    evidenceKey: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
    ingestionKey: `${testPrefix}-snapshot-a`,
    matchDecision: "BARE" as const,
    comparable: true,
    matchConfidenceBps: 9_800,
    normalizedModel: "Sony MDR-7506",
    matchReasons: ["same model"],
    capturedAt: new Date("2026-08-24T01:30:00.000Z")
  };

  await prisma.offerSnapshot.create({ data: firstSnapshot });
  await prisma.offerSnapshot.create({
    data: {
      ...firstSnapshot,
      skuId: "white",
      skuText: "白色",
      ingestionKey: `${testPrefix}-snapshot-b`
    }
  });
  await prisma.collectionIssue.create({
    data: {
      collectionRunId: run.id,
      issueKey: `${testPrefix}-issue`,
      code: "SKU_ENUMERATION_INCOMPLETE",
      platformItemId: candidate.platformItemId,
      message: "The collector could not enumerate every SKU.",
      evidenceKey: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      capturedAt: new Date("2026-08-24T01:31:00.000Z")
    }
  });

  assert.equal(await prisma.collectionSearchPosition.count({ where: { collectionRunId: run.id } }), 2);
  assert.equal(await prisma.offerSnapshot.count({ where: { collectionRunId: run.id } }), 2);
  assert.equal(await prisma.collectionIssue.count({ where: { collectionRunId: run.id } }), 1);
  await assert.rejects(
    () => prisma.collectionSearchPosition.create({ data: firstPosition }),
    isUniqueConstraintError
  );
  await assert.rejects(
    () => prisma.offerSnapshot.create({ data: firstSnapshot }),
    isUniqueConstraintError
  );
  await assert.rejects(() => prisma.collectionIssue.create({
    data: {
      collectionRunId: run.id,
      issueKey: `${testPrefix}-issue`,
      code: "SKU_ENUMERATION_INCOMPLETE",
      message: "Duplicate issue key.",
      capturedAt: new Date("2026-08-24T01:32:00.000Z")
    }
  }), isUniqueConstraintError);
});
