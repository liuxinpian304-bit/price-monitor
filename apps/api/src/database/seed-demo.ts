import "dotenv/config";

import { Prisma, type AlertSeverity, type AlertStatus, type ComparisonType } from "../../../../generated/prisma/client.ts";
import { createPrismaClient } from "./prisma.service.ts";

interface DemoModel {
  id: string;
  monitorCode: string;
  brand: string;
  model: string;
  category: string;
  type: ComparisonType;
  owner: string;
  ownPriceFen: number;
  competitorPriceFen: number;
  competitorShop: string;
  sku: string;
  itemId: string;
  alert?: { id: string; status: AlertStatus; severity: AlertSeverity };
  bundleCode?: string;
}

const demoModels: DemoModel[] = [
  {
    id: "demo-model-rme-bare",
    monitorCode: "MON-0001",
    brand: "RME",
    model: "Babyface Pro FS",
    category: "声卡",
    type: "BARE",
    owner: "运营A",
    ownPriceFen: 701_000,
    competitorPriceFen: 700_999,
    competitorShop: "示例同行店A",
    sku: "Babyface Pro FS 单机 / FS 新版",
    itemId: "1001",
    alert: { id: "demo-alert-rme-bare", status: "PENDING", severity: "CONFIRMED_LOW" }
  },
  {
    id: "demo-model-rme-bundle-mk4",
    monitorCode: "MON-0002",
    brand: "RME",
    model: "Babyface Pro FS MK4录音套装",
    category: "声卡套装",
    type: "BUNDLE",
    owner: "运营A",
    ownPriceFen: 855_000,
    competitorPriceFen: 854_000,
    competitorShop: "示例同行店B",
    sku: "Babyface Pro FS + MK4 套装",
    itemId: "1002",
    alert: { id: "demo-alert-rme-bundle-mk4", status: "PENDING", severity: "CONFIRMED_LOW" },
    bundleCode: "BUNDLE-RME-MK4"
  },
  {
    id: "demo-model-sennheiser-mk4",
    monitorCode: "MON-0003",
    brand: "Sennheiser",
    model: "MK4",
    category: "麦克风",
    type: "BARE",
    owner: "运营B",
    ownPriceFen: 321_000,
    competitorPriceFen: 320_000,
    competitorShop: "示例同行店C",
    sku: "MK4 官方标配 / 国行",
    itemId: "1003",
    alert: { id: "demo-alert-sennheiser-mk4", status: "WATCHING", severity: "CONFIRMED_LOW" }
  },
  {
    id: "demo-model-neumann-kms105",
    monitorCode: "MON-0004",
    brand: "Neumann",
    model: "KMS 105",
    category: "麦克风",
    type: "BARE",
    owner: "运营C",
    ownPriceFen: 478_000,
    competitorPriceFen: 477_000,
    competitorShop: "示例同行店A",
    sku: "KMS 105 镍色 / 国行",
    itemId: "1004",
    alert: { id: "demo-alert-neumann-kms105", status: "PENDING", severity: "CONFIRMED_LOW" }
  },
  {
    id: "demo-model-rme-bundle-mk8",
    monitorCode: "MON-0005",
    brand: "RME",
    model: "Babyface Pro FS MK8套装",
    category: "声卡套装",
    type: "BUNDLE",
    owner: "运营A",
    ownPriceFen: 936_000,
    competitorPriceFen: 935_000,
    competitorShop: "示例同行店B",
    sku: "Babyface Pro FS + MK8 套装",
    itemId: "1005",
    alert: { id: "demo-alert-rme-bundle-mk8", status: "WATCHING", severity: "MANUAL_REVIEW" },
    bundleCode: "BUNDLE-RME-MK8"
  },
  {
    id: "demo-model-kali-lpunf",
    monitorCode: "MON-0006",
    brand: "Kali Audio",
    model: "LP-UNF",
    category: "监听音箱",
    type: "BARE",
    owner: "运营C",
    ownPriceFen: 264_000,
    competitorPriceFen: 263_000,
    competitorShop: "示例同行店C",
    sku: "黑色一对",
    itemId: "1006"
  }
];

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

async function seedBundle(prisma: ReturnType<typeof createPrismaClient>, code: string, microphone: string) {
  const bundle = await prisma.bundle.upsert({
    where: { code },
    create: { code, title: `RME Babyface Pro FS + ${microphone}` },
    update: { title: `RME Babyface Pro FS + ${microphone}` }
  });
  await prisma.bundleItem.deleteMany({ where: { bundleId: bundle.id } });
  await prisma.bundleItem.createMany({
    data: [
      { bundleId: bundle.id, accessoryType: "声卡", brand: "RME", modelOrName: "Babyface Pro FS", quantity: 1, unitValueFen: 730_000, core: true },
      { bundleId: bundle.id, accessoryType: "麦克风", brand: "Sennheiser", modelOrName: microphone, quantity: 1, unitValueFen: microphone === "MK4" ? 219_900 : 289_900, core: true },
      { bundleId: bundle.id, accessoryType: "音频线", brand: "STAU", modelOrName: "XLR 连接线", quantity: 1, unitValueFen: 9_900, core: false }
    ]
  });
  return bundle.id;
}

async function seed() {
  if (process.env.NODE_ENV === "production" && process.env.ALLOW_DEMO_SEED !== "true") {
    throw new Error("生产环境禁止写入演示数据");
  }

  const prisma = createPrismaClient();
  try {
    const bundleIds = new Map<string, string>();
    bundleIds.set("BUNDLE-RME-MK4", await seedBundle(prisma, "BUNDLE-RME-MK4", "MK4"));
    bundleIds.set("BUNDLE-RME-MK8", await seedBundle(prisma, "BUNDLE-RME-MK8", "MK8"));

    for (const [index, model] of demoModels.entries()) {
      const bundleId = model.bundleCode ? bundleIds.get(model.bundleCode) ?? null : null;
      await prisma.monitoredModel.upsert({
        where: { id: model.id },
        create: {
          id: model.id,
          monitorCode: model.monitorCode,
          enabled: true,
          brand: model.brand,
          standardModel: model.model,
          category: model.category,
          searchQuery: `${model.brand} ${model.model}`,
          version: model.model.includes("Babyface") ? "FS新版" : null,
          mustIncludeTerms: [],
          excludedTerms: ["二手", "维修", "定金"],
          comparisonType: model.type,
          colorComparable: false,
          owner: model.owner,
          notes: "本地试运行演示数据，可由正式 Excel 导入覆盖",
          bundleId
        },
        update: {
          monitorCode: model.monitorCode,
          brand: model.brand,
          standardModel: model.model,
          category: model.category,
          comparisonType: model.type,
          owner: model.owner,
          bundleId
        }
      });

      const ownUrl = `https://example.com/demo/1`;
      const ownListing = await prisma.ownListing.upsert({
        where: { monitoredModelId_url_skuText: { monitoredModelId: model.id, url: ownUrl, skuText: model.sku } },
        create: { monitoredModelId: model.id, platform: "TMALL", shopName: "星空乐器专营店", url: ownUrl, skuText: model.sku },
        update: { active: true }
      });

      const capturedAt = new Date(Date.now() - index * 11 * 60 * 1000);
      const runId = `demo-run-${model.itemId}`;
      await prisma.collectionRun.upsert({
        where: { id: runId },
        create: {
          id: runId,
          monitoredModelId: model.id,
          providerKey: "demo-fixture",
          status: "SUCCEEDED",
          scheduledFor: capturedAt,
          startedAt: capturedAt,
          finishedAt: new Date(capturedAt.getTime() + 3_000),
          searchedCount: 20,
          fetchedCount: 8,
          matchedCount: 2,
          failedCount: 0
        },
        update: { status: "SUCCEEDED", finishedAt: new Date(capturedAt.getTime() + 3_000) }
      });

      const competitorUrl = `https://example.com/demo/2`;
      const candidate = await prisma.searchCandidate.upsert({
        where: {
          monitoredModelId_providerKey_platformItemId: {
            monitoredModelId: model.id,
            providerKey: "demo-fixture",
            platformItemId: model.itemId
          }
        },
        create: {
          id: `demo-candidate-${model.itemId}`,
          monitoredModelId: model.id,
          providerKey: "demo-fixture",
          platformItemId: model.itemId,
          url: competitorUrl,
          shopName: model.competitorShop,
          title: `${model.brand} ${model.model} ${model.sku}`,
          decision: model.alert?.severity === "MANUAL_REVIEW" ? "MANUAL" : model.type,
          comparable: model.alert?.severity !== "MANUAL_REVIEW",
          confidenceBps: model.alert?.severity === "MANUAL_REVIEW" ? 6500 : 9800,
          normalizedModel: model.model,
          reasons: json(model.alert?.severity === "MANUAL_REVIEW" ? ["套装核心配件不同，需人工核对"] : ["同品牌、同型号、同版本"]),
          lastSeenAt: capturedAt
        },
        update: { shopName: model.competitorShop, url: competitorUrl, lastSeenAt: capturedAt }
      });

      const ownSnapshot = await prisma.offerSnapshot.upsert({
        where: { id: `demo-own-snapshot-${model.itemId}` },
        create: {
          id: `demo-own-snapshot-${model.itemId}`,
          collectionRunId: runId,
          ownListingId: ownListing.id,
          platformItemId: `own-${model.itemId}`,
          skuId: `own-sku-${model.itemId}`,
          shopName: "星空乐器专营店",
          title: `${model.brand} ${model.model}`,
          skuText: model.sku,
          listPriceFen: model.ownPriceFen,
          payableFen: model.ownPriceFen,
          stockState: "IN_STOCK",
          evidenceUrl: ownUrl,
          capturedAt
        },
        update: { payableFen: model.ownPriceFen, capturedAt }
      });

      const competitorSnapshot = await prisma.offerSnapshot.upsert({
        where: { id: `demo-competitor-snapshot-${model.itemId}` },
        create: {
          id: `demo-competitor-snapshot-${model.itemId}`,
          collectionRunId: runId,
          searchCandidateId: candidate.id,
          platformItemId: model.itemId,
          skuId: `sku-${model.itemId}`,
          shopName: model.competitorShop,
          title: `${model.brand} ${model.model}`,
          skuText: model.sku,
          listPriceFen: model.competitorPriceFen,
          payableFen: model.competitorPriceFen,
          stockState: "IN_STOCK",
          evidenceUrl: competitorUrl,
          capturedAt
        },
        update: { payableFen: model.competitorPriceFen, capturedAt }
      });

      if (model.alert) {
        await prisma.priceAlert.upsert({
          where: { id: model.alert.id },
          create: {
            id: model.alert.id,
            monitoredModelId: model.id,
            ownSnapshotId: ownSnapshot.id,
            competitorSnapshotId: competitorSnapshot.id,
            severity: model.alert.severity,
            status: model.alert.status,
            dedupKey: `demo:${model.itemId}:${model.competitorPriceFen}`,
            ownPriceFen: model.ownPriceFen,
            competitorPriceFen: model.competitorPriceFen,
            differenceFen: model.ownPriceFen - model.competitorPriceFen,
            reasons: json(model.alert.severity === "MANUAL_REVIEW" ? ["套装核心配置不同，仅供人工核对"] : ["同行同 SKU 到手价低于我方"]),
            firstSeenAt: capturedAt,
            lastSeenAt: capturedAt
          },
          update: {
            ownSnapshotId: ownSnapshot.id,
            competitorSnapshotId: competitorSnapshot.id,
            ownPriceFen: model.ownPriceFen,
            competitorPriceFen: model.competitorPriceFen,
            differenceFen: model.ownPriceFen - model.competitorPriceFen,
            lastSeenAt: capturedAt
          }
        });
      }
    }

    process.stdout.write(`Seeded ${demoModels.length} monitored models\n`);
  } finally {
    await prisma.$disconnect();
  }
}

await seed();
