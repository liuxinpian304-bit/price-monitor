import "dotenv/config";

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { createPrismaClient } from "../../database/prisma.service.ts";
import type { ValidatedCatalogImport } from "./catalog-import.service.ts";
import { PrismaCatalogImportWriter } from "./prisma-catalog-import.writer.ts";

const prisma = createPrismaClient();

async function clearCatalog(): Promise<void> {
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

function catalog(owner = "张三"): ValidatedCatalogImport {
  return {
    models: [{
      sourceRow: 5,
      monitorCode: "MON-0001",
      enabled: true,
      brand: "RME",
      standardModel: "Babyface Pro FS",
      category: "声卡",
      searchQuery: "RME Babyface Pro FS",
      version: "FS新版",
      mustIncludeTerms: ["Babyface", "FS"],
      excludedTerms: ["二手"],
      ownUrl: "https://detail.tmall.com/item.htm?id=1001",
      ownSkuText: "Babyface Pro FS单机",
      comparisonType: "BARE",
      bundleCode: null,
      colorComparable: false,
      owner,
      notes: null,
      ownListing: {
        platform: "TMALL",
        shopName: "星空乐器专营店",
        url: "https://detail.tmall.com/item.htm?id=1001",
        skuText: "Babyface Pro FS单机"
      }
    }],
    bundles: [],
    aliases: [{
      sourceRow: 5,
      brand: "RME",
      standardModel: "Babyface Pro FS",
      phrase: "娃娃脸FS",
      type: "EFFECTIVE",
      notes: null
    }]
  };
}

before(async () => {
  await prisma.$connect();
});

beforeEach(clearCatalog);

after(async () => {
  await clearCatalog();
  await prisma.$disconnect();
});

test("inserts new models, updates existing models and records the actor", async () => {
  const writer = new PrismaCatalogImportWriter(prisma);

  assert.deepEqual(await writer.importAtomically(catalog(), "operator-1"), {
    imported: 1,
    updated: 0
  });
  assert.deepEqual(await writer.importAtomically(catalog("李四"), "operator-2"), {
    imported: 0,
    updated: 1
  });

  const stored = await prisma.monitoredModel.findUniqueOrThrow({
    where: { monitorCode: "MON-0001" },
    include: { aliases: true, ownListings: true }
  });
  assert.equal(stored.owner, "李四");
  assert.equal(stored.aliases.length, 1);
  assert.equal(stored.ownListings[0]?.shopName, "星空乐器专营店");

  const audits = await prisma.auditLog.findMany({ orderBy: { createdAt: "asc" } });
  assert.deepEqual(audits.map((audit) => audit.actorId), ["operator-1", "operator-2"]);
  assert.equal(audits[0]?.before, null);
  assert.notEqual(audits[1]?.before, null);
});

test("rolls back every write when one row fails inside the transaction", async () => {
  const writer = new PrismaCatalogImportWriter(prisma);
  const invalid = catalog();
  invalid.aliases.push({ ...invalid.aliases[0]!, sourceRow: 6 });

  await assert.rejects(() => writer.importAtomically(invalid, "operator-1"));

  assert.equal(await prisma.monitoredModel.count(), 0);
  assert.equal(await prisma.ownListing.count(), 0);
  assert.equal(await prisma.auditLog.count(), 0);
});
