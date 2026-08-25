import "dotenv/config";

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { createPrismaClient } from "../database/prisma.service.ts";
import {
  CollectionRunQueueService,
  PrismaCollectionRunQueueRepository
} from "./collection-run-queue.service.ts";

const prisma = createPrismaClient();
const testPrefix = `TASK13-${process.pid}-${Date.now()}`;

const createdModelIds: string[] = [];
const createdAgentIds: string[] = [];

before(async () => { await prisma.$connect(); });
after(async () => {
  if (createdModelIds.length > 0) {
    await prisma.monitoredModel.deleteMany({ where: { id: { in: createdModelIds } } });
  }
  if (createdAgentIds.length > 0) {
    await prisma.collectorAgent.deleteMany({ where: { id: { in: createdAgentIds } } });
  }
  await prisma.$disconnect();
});

test("database scheduling is slot-idempotent and coalesces later unfinished work", async () => {
  const model = await prisma.monitoredModel.create({
    data: {
      monitorCode: `${testPrefix}-1`,
      brand: "RME",
      standardModel: "Babyface Pro FS",
      category: "声卡",
      searchQuery: "RME Babyface Pro FS",
      mustIncludeTerms: [],
      excludedTerms: [],
      comparisonType: "BARE",
      owner: "测试"
    }
  });
  createdModelIds.push(model.id);
  const service = new CollectionRunQueueService(new PrismaCollectionRunQueueRepository(prisma));
  const scheduledFor = new Date("2026-08-25T01:30:00.000Z");

  const first = await service.enqueueEnabledModels(scheduledFor);
  const duplicate = await service.enqueueEnabledModels(scheduledFor);
  const manual = await service.enqueueModelNow(model.id, "admin-1", 7, new Date("2026-08-25T02:30:00.000Z"));

  assert.equal(first.length, 1);
  assert.equal(duplicate[0]?.run.id, first[0]?.run.id);
  assert.deepEqual(manual, { runId: manual.runId, coalesced: true });
  const rows = await prisma.collectionRun.findMany({ orderBy: { scheduledFor: "asc" } });
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.status, "QUEUED");
  assert.equal(rows[1]?.status, "COALESCED");
  assert.equal(rows[1]?.coalescedIntoRunId, rows[0]?.id);
  assert.equal(rows[1]?.searchLimit, 7);
});

test("requeue preserves desktop ownership checkpoint while clearing a pause", async () => {
  const model = await prisma.monitoredModel.create({
    data: {
      monitorCode: `${testPrefix}-2`,
      brand: "RME",
      standardModel: "Babyface Pro FS",
      category: "声卡",
      searchQuery: "RME Babyface Pro FS",
      mustIncludeTerms: [],
      excludedTerms: [],
      comparisonType: "BARE",
      owner: "测试"
    }
  });
  createdModelIds.push(model.id);
  const agent = await prisma.collectorAgent.create({
    data: { name: `${testPrefix}-agent`, platform: "MACOS", tokenHash: `${testPrefix}-token` }
  });
  createdAgentIds.push(agent.id);
  const run = await prisma.collectionRun.create({
    data: {
      monitoredModelId: model.id,
      providerKey: "taobao-desktop",
      scheduledFor: new Date("2026-08-25T01:30:00.000Z"),
      status: "PAUSED_LOGIN",
      collectorAgentId: agent.id,
      claimedOwnListingIds: ["listing-1"],
      errorCode: "LOGIN_REQUIRED",
      errorMessage: "login"
    }
  });
  const service = new CollectionRunQueueService(new PrismaCollectionRunQueueRepository(prisma));

  assert.deepEqual(await service.requeuePausedRun(run.id), { runId: run.id });
  const retried = await prisma.collectionRun.findUniqueOrThrow({ where: { id: run.id } });
  assert.equal(retried.status, "QUEUED");
  assert.equal(retried.collectorAgentId, agent.id);
  assert.deepEqual(retried.claimedOwnListingIds, ["listing-1"]);
  assert.equal(retried.errorCode, null);
  assert.equal(retried.errorMessage, null);

  const nonDesktop = await prisma.collectionRun.create({
    data: {
      monitoredModelId: model.id,
      providerKey: "manual-fixtures",
      scheduledFor: new Date("2026-08-25T02:30:00.000Z"),
      status: "PAUSED_LOGIN"
    }
  });
  await assert.rejects(() => service.requeuePausedRun(nonDesktop.id));
});
