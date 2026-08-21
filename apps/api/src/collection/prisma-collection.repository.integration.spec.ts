import "dotenv/config";

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";

import { createPrismaClient } from "../database/prisma.service.ts";
import { MatcherService } from "../matching/matcher.service.ts";
import { PriceEngineService } from "../pricing/price-engine.service.ts";
import { CollectionService, type CollectionLock } from "./collection.service.ts";
import { PrismaCollectionRepository } from "./prisma-collection.repository.ts";
import { ManualImportProvider } from "./providers/manual/manual-import.provider.ts";

const prisma = createPrismaClient();
const FIXTURE_ROOT = new URL("../../../../tests/fixtures/providers/", import.meta.url);

async function fixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(new URL(name, FIXTURE_ROOT), "utf8"));
}

async function clearData(): Promise<void> {
  await prisma.alertAction.deleteMany();
  await prisma.priceAlert.deleteMany();
  await prisma.offerSnapshot.deleteMany();
  await prisma.collectionRun.deleteMany();
  await prisma.searchCandidate.deleteMany();
  await prisma.ownListing.deleteMany();
  await prisma.modelAlias.deleteMany();
  await prisma.monitoredModel.deleteMany();
  await prisma.bundleItem.deleteMany();
  await prisma.bundle.deleteMany();
  await prisma.auditLog.deleteMany();
}

class TestLock implements CollectionLock {
  async acquire() { return "integration-lock"; }
  async release() {}
}

before(async () => {
  await prisma.$connect();
});

beforeEach(clearData);

after(async () => {
  await clearData();
  await prisma.$disconnect();
});

test("stores a complete fixture collection and reuses the summary for the same runId", async () => {
  const monitored = await prisma.monitoredModel.create({
    data: {
      monitorCode: "MON-0001",
      brand: "RME",
      standardModel: "Babyface Pro FS",
      category: "声卡",
      searchQuery: "RME Babyface Pro FS",
      version: "FS新版",
      mustIncludeTerms: ["Babyface", "FS"],
      excludedTerms: ["二手", "定金", "维修"],
      comparisonType: "BARE",
      owner: "张三",
      aliases: {
        create: { phrase: "娃娃脸FS", type: "EFFECTIVE" }
      },
      ownListings: {
        create: {
          url: "https://detail.tmall.com/item.htm?id=own-1",
          skuText: "Babyface Pro FS单机"
        }
      }
    }
  });
  const searchResponse = await fixture("search-results.json");
  const bare = await fixture("product-bare.json");
  const bundle = await fixture("product-bundle.json");
  const provider = new ManualImportProvider({
    searchResponse,
    offersByUrl: new Map([
      ["https://example.com/fixtures/bare", bare],
      ["https://example.com/fixtures/bundle", bundle],
    ])
  });
  const repository = new PrismaCollectionRepository(prisma, "manual-fixtures");
  const service = new CollectionService(
    repository,
    provider,
    new MatcherService(),
    new PriceEngineService(),
    new TestLock()
  );

  const first = await service.runMonitoredModel(monitored.id, "run-integration-1");
  const second = await service.runMonitoredModel(monitored.id, "run-integration-1");

  assert.deepEqual(first, { searched: 2, fetched: 2, matched: 1, failed: 0 });
  assert.deepEqual(second, first);
  assert.equal(await prisma.collectionRun.count(), 1);
  assert.equal(await prisma.searchCandidate.count(), 2);
  assert.equal(await prisma.offerSnapshot.count(), 2);
  const snapshots = await prisma.offerSnapshot.findMany({ orderBy: { platformItemId: "asc" } });
  assert.equal(snapshots[0]?.payableFen, 460_100);
  assert.notEqual(snapshots[0]?.payableFen, 12_345);
  assert.deepEqual(snapshots[0]?.rawEvidence, bare);
  const decisions = await prisma.searchCandidate.findMany({
    select: { decision: true, comparable: true },
    orderBy: { platformItemId: "asc" }
  });
  assert.deepEqual(decisions, [
    { decision: "BARE", comparable: true },
    { decision: "BUNDLE", comparable: false }
  ]);
});
