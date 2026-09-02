import "dotenv/config";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { createPrismaClient } from "../database/prisma.service.ts";

const prisma = createPrismaClient();
const testPrefix = `TASK2-${randomUUID().slice(0, 8)}`;

let monitoredModelId: string | undefined;
let ownListingId: string | undefined;
let runId: string | undefined;

async function clearData(): Promise<void> {
  if (runId) await prisma.collectionRun.deleteMany({ where: { id: runId } });
  if (ownListingId) await prisma.ownListing.deleteMany({ where: { id: ownListingId } });
  if (monitoredModelId) await prisma.monitoredModel.deleteMany({ where: { id: monitoredModelId } });
}

before(async () => {
  await prisma.$connect();
});

after(async () => {
  await clearData();
  await prisma.$disconnect();
});

test("persists SKU combination evaluation without backfilling old-style snapshots", async () => {
  const monitoredModel = await prisma.monitoredModel.create({
    data: {
      monitorCode: `${testPrefix}-NT1S`,
      brand: "RODE",
      standardModel: "NT1S",
      category: "microphone",
      searchQuery: "RODE NT1S",
      comparisonType: "BARE",
      owner: "sku-combination-schema-test"
    }
  });
  monitoredModelId = monitoredModel.id;
  const ownListing = await prisma.ownListing.create({
    data: {
      monitoredModelId: monitoredModel.id,
      platform: "TAOBAO",
      shopName: "Own Shop",
      url: `https://detail.tmall.com/item.htm?id=${testPrefix}-own`,
      skuText: "RODE NT1S 新品 单只"
    }
  });
  ownListingId = ownListing.id;
  const run = await prisma.collectionRun.create({
    data: {
      monitoredModelId: monitoredModel.id,
      providerKey: "taobao-desktop",
      status: "SUCCEEDED",
      scheduledFor: new Date("2026-08-28T10:00:00.000Z")
    }
  });
  runId = run.id;
  const own = await prisma.offerSnapshot.create({
    data: {
      collectionRunId: run.id,
      ownListingId: ownListing.id,
      platformItemId: `${testPrefix}-own-item`,
      skuId: "own-sku",
      shopName: ownListing.shopName,
      title: "RODE NT1S",
      skuText: ownListing.skuText,
      capturedAt: new Date("2026-08-28T10:00:01.000Z")
    }
  });
  const competitor = await prisma.offerSnapshot.create({
    data: {
      collectionRunId: run.id,
      platformItemId: `${testPrefix}-competitor-item`,
      skuId: "competitor-sku",
      shopName: "Competitor Shop",
      title: "RODE NT1S",
      skuText: "RODE NT1S 新品 单只",
      capturedAt: new Date("2026-08-28T10:00:02.000Z")
    }
  });
  const oldStyle = await prisma.offerSnapshot.create({
    data: {
      collectionRunId: run.id,
      platformItemId: `${testPrefix}-old-style-item`,
      skuId: "old-style-sku",
      shopName: "Historic Shop",
      title: "RODE NT1S",
      skuText: "RODE NT1S 单只",
      capturedAt: new Date("2026-08-28T10:00:03.000Z")
    }
  });

  await prisma.offerSnapshot.update({
    where: { id: competitor.id },
    data: {
      combinationSignature: `sku-combination-v1:${"a".repeat(64)}`,
      combinationLabel: "RODE NT1S 新品 单只",
      combinationState: "MATCHED",
      combinationReasons: { ruleVersion: "sku-combination-v1", codes: ["EXACT_SIGNATURE"] },
      comparisonOwnSnapshotId: own.id
    }
  });

  const stored = await prisma.offerSnapshot.findUniqueOrThrow({
    where: { id: competitor.id },
    include: { comparisonOwnSnapshot: true }
  });
  const storedOldStyle = await prisma.offerSnapshot.findUniqueOrThrow({ where: { id: oldStyle.id } });
  const storedRun = await prisma.collectionRun.findUniqueOrThrow({ where: { id: run.id } });

  assert.equal(stored.comparisonOwnSnapshot?.id, own.id);
  assert.equal(stored.combinationSignature, `sku-combination-v1:${"a".repeat(64)}`);
  assert.equal(stored.combinationLabel, "RODE NT1S 新品 单只");
  assert.equal(stored.combinationState, "MATCHED");
  assert.deepEqual(stored.combinationReasons, {
    ruleVersion: "sku-combination-v1",
    codes: ["EXACT_SIGNATURE"]
  });
  assert.equal(storedOldStyle.combinationSignature, null);
  assert.equal(storedOldStyle.combinationLabel, null);
  assert.equal(storedOldStyle.combinationState, null);
  assert.equal(storedOldStyle.combinationReasons, null);
  assert.equal(storedOldStyle.comparisonOwnSnapshotId, null);
  assert.equal(Reflect.get(storedRun, "alertEvaluationVersion"), null);

  await prisma.offerSnapshot.delete({ where: { id: own.id } });
  const afterOwnDelete = await prisma.offerSnapshot.findUniqueOrThrow({ where: { id: competitor.id } });
  assert.equal(afterOwnDelete.comparisonOwnSnapshotId, null);
});
