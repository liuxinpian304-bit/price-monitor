import "dotenv/config";

import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";

import { createPrismaClient } from "../database/prisma.service.ts";
import {
  CollectionRunQueueService,
  PrismaCollectionRunQueueRepository
} from "./collection-run-queue.service.ts";

const prisma = createPrismaClient();
const testPrefix = `TASK13-${process.pid}-${Date.now()}`;

const createdModelIds: string[] = [];
const createdAgentIds: string[] = [];
const createdRunIds: string[] = [];

before(async () => { await prisma.$connect(); });
afterEach(async () => {
  if (createdRunIds.length > 0) {
    await prisma.collectionRun.deleteMany({ where: { id: { in: createdRunIds.splice(0) } } });
  }
  if (createdModelIds.length > 0) {
    await prisma.monitoredModel.deleteMany({ where: { id: { in: createdModelIds.splice(0) } } });
  }
  if (createdAgentIds.length > 0) {
    await prisma.collectorAgent.deleteMany({ where: { id: { in: createdAgentIds.splice(0) } } });
  }
});
after(async () => {
  await prisma.$disconnect();
});

test("concurrent same-slot creation returns one idempotent run to both callers", async () => {
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
  const repository = new PrismaCollectionRunQueueRepository(prisma);
  const scheduledFor = new Date("2026-08-25T01:30:00.000Z");
  const input = {
    monitoredModelId: model.id,
    providerKey: "taobao-desktop" as const,
    scheduledFor,
    searchLimit: 50,
    actorId: null
  };

  const [first, duplicate] = await Promise.all([
    repository.createOrCoalesce(input),
    repository.createOrCoalesce(input)
  ]);
  createdRunIds.push(first.run.id);

  assert.equal(duplicate.run.id, first.run.id);
  const rows = await prisma.collectionRun.findMany({
    where: { monitoredModelId: model.id, providerKey: "taobao-desktop", scheduledFor }
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.status, "QUEUED");
  assert.equal(await prisma.collectionRun.count({
    where: {
      id: first.run.id,
      monitoredModel: { ownListings: { some: { active: true } } }
    }
  }), 0);
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
  createdRunIds.push(run.id);
  const service = new CollectionRunQueueService(new PrismaCollectionRunQueueRepository(prisma));

  await assert.rejects(() => service.requeuePausedRun(run.id));
  assert.equal((await prisma.collectionRun.findUniqueOrThrow({ where: { id: run.id } })).status, "PAUSED_LOGIN");
  await prisma.collectorAgent.update({
    where: { id: agent.id },
    data: { sessionState: "READY", sessionObservedAt: new Date(), sessionChangedAt: new Date() }
  });
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
  createdRunIds.push(nonDesktop.id);
  await assert.rejects(() => service.requeuePausedRun(nonDesktop.id));
});
