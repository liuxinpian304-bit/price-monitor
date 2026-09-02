import "dotenv/config";

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { createPrismaClient } from "../database/prisma.service.ts";
import {
  COLLECTOR_RUN_LEASE_MILLISECONDS,
  PrismaCollectorAgentRepository
} from "./prisma-collector-agent.repository.ts";

const prisma = createPrismaClient();
const prefix = `COLLECTOR-RECOVERY-${process.pid}-${Date.now()}`;
const ids: { model?: string; owner?: string; other?: string; run?: string } = {};

before(async () => {
  await prisma.$connect();
  const model = await prisma.monitoredModel.create({
    data: {
      monitorCode: `${prefix}-MODEL`,
      brand: "Fixture",
      standardModel: "MODEL-1",
      category: "fixture",
      searchQuery: "fixture model",
      comparisonType: "BARE",
      owner: "fixture-owner",
      ownListings: {
        create: {
          platformItemId: "fixture-own",
          url: "https://example.test/item.htm?id=fixture-own",
          skuText: "MODEL-1 单机"
        }
      }
    }
  });
  ids.model = model.id;
  const [owner, other] = await Promise.all([
    prisma.collectorAgent.create({
      data: { name: `${prefix}-OWNER`, platform: "MACOS", tokenHash: `${prefix}-TOKEN-OWNER` }
    }),
    prisma.collectorAgent.create({
      data: { name: `${prefix}-OTHER`, platform: "MACOS", tokenHash: `${prefix}-TOKEN-OTHER` }
    })
  ]);
  ids.owner = owner.id;
  ids.other = other.id;
});

after(async () => {
  if (ids.run) await prisma.collectionRun.deleteMany({ where: { id: ids.run } });
  if (ids.model) await prisma.monitoredModel.deleteMany({ where: { id: ids.model } });
  await prisma.collectorAgent.deleteMany({ where: { id: { in: [ids.owner!, ids.other!] } } });
  await prisma.$disconnect();
});

test("only the owning agent reclaims a stale running checkpoint lease", async () => {
  const run = await prisma.collectionRun.create({
    data: {
      monitoredModelId: ids.model!,
      providerKey: "taobao-desktop",
      status: "QUEUED",
      scheduledFor: new Date()
    }
  });
  ids.run = run.id;
  const repository = new PrismaCollectorAgentRepository(prisma);
  const capabilities = {
    appVersion: "2.4.5",
    capabilities: ["accessibility", "all-sku", "png-evidence"]
  };

  const originallyClaimed = await repository.claimNext(ids.owner!, capabilities);
  assert.equal(originallyClaimed?.runId, run.id);
  assert.equal(originallyClaimed?.searchQuery, "fixture model");

  await prisma.monitoredModel.update({
    where: { id: ids.model! },
    data: { searchQuery: "edited catalog query must not replace a checkpoint job" }
  });
  const staleAt = new Date(Date.now() - COLLECTOR_RUN_LEASE_MILLISECONDS - 1_000);
  await prisma.collectionRun.update({
    where: { id: run.id },
    data: { heartbeatAt: staleAt }
  });

  assert.equal(await repository.claimNext(ids.other!, capabilities), null);
  const reclaimed = await repository.claimNext(ids.owner!, capabilities);
  assert.deepEqual(reclaimed, originallyClaimed);

  assert.equal(await repository.claimNext(ids.owner!, capabilities), null);
  assert.equal(await repository.claimNext(ids.other!, capabilities), null);
});
