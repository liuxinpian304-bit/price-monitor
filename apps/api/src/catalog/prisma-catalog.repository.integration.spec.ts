import "dotenv/config";

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { AuditService } from "../audit/audit.service.ts";
import { PrismaAuditRepository } from "../audit/prisma-audit.repository.ts";
import { createPrismaClient } from "../database/prisma.service.ts";
import { CatalogService } from "./catalog.service.ts";
import { PrismaCatalogRepository } from "./prisma-catalog.repository.ts";

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

before(async () => {
  await prisma.$connect();
});

beforeEach(clearCatalog);

after(async () => {
  await clearCatalog();
  await prisma.$disconnect();
});

test("persists catalog CRUD, related data and audit logs in PostgreSQL", async () => {
  await prisma.bundle.create({
    data: {
      code: "PKG-RME-001",
      title: "RME Babyface Pro FS 套装",
      items: {
        create: {
          accessoryType: "麦克风",
          brand: "Sennheiser",
          modelOrName: "MK4",
          quantity: 1,
          unitValueFen: 180_000,
          core: true
        }
      }
    }
  });

  const repository = new PrismaCatalogRepository(prisma);
  const service = new CatalogService(
    repository,
    new AuditService(new PrismaAuditRepository(prisma))
  );
  const created = await service.createModel({
    monitorCode: "MON-0001",
    enabled: true,
    brand: "RME",
    standardModel: "Babyface Pro FS",
    category: "声卡",
    searchQuery: "RME Babyface Pro FS 套装",
    version: "FS新版",
    mustIncludeTerms: ["Babyface", "FS"],
    excludedTerms: ["二手"],
    ownUrl: "https://detail.tmall.com/item.htm?id=1001",
    ownSkuText: "Babyface Pro FS+MK4套装",
    comparisonType: "BUNDLE",
    bundleCode: "PKG-RME-001",
    colorComparable: false,
    owner: "张三",
    notes: null
  }, "operator-1");

  await prisma.modelAlias.create({
    data: {
      monitoredModelId: created.id,
      phrase: "娃娃脸FS",
      type: "EFFECTIVE"
    }
  });

  const updated = await service.updateModel(created.id, { owner: "李四" }, "operator-2");
  const disabled = await service.toggleModel(created.id, "operator-3");

  assert.equal(updated.owner, "李四");
  assert.equal(disabled.enabled, false);
  assert.equal((await service.listModels()).length, 1);
  assert.equal((await service.listBundles(created.id))[0]?.items?.[0]?.unitValueFen, 180_000);
  assert.equal((await service.listAliases(created.id))[0]?.phrase, "娃娃脸FS");
  assert.deepEqual(
    (await prisma.auditLog.findMany({ orderBy: { createdAt: "asc" } })).map((entry) => entry.actorId),
    ["operator-1", "operator-2", "operator-3"]
  );
});
