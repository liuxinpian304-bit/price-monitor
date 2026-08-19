import type { PrismaClient } from "../../../../generated/prisma/client.ts";

import type { ValidatedCatalogModelInput } from "./catalog.dto.ts";
import type {
  CatalogAliasSummary,
  CatalogBundleSummary,
  CatalogModelRecord,
  CatalogRepository
} from "./catalog.service.ts";

interface LoadedModel {
  id: string;
  monitorCode: string;
  enabled: boolean;
  brand: string;
  standardModel: string;
  category: string;
  searchQuery: string;
  version: string | null;
  mustIncludeTerms: string[];
  excludedTerms: string[];
  comparisonType: "BARE" | "BUNDLE";
  colorComparable: boolean;
  owner: string;
  notes: string | null;
  bundle: { code: string } | null;
  ownListings: Array<{ url: string; skuText: string }>;
}

const modelInclude = {
  bundle: { select: { code: true } },
  ownListings: {
    orderBy: [{ active: "desc" as const }, { updatedAt: "desc" as const }],
    take: 1,
    select: { url: true, skuText: true }
  }
};

function writeData(input: ValidatedCatalogModelInput, bundleId: string | null) {
  return {
    monitorCode: input.monitorCode,
    enabled: input.enabled,
    brand: input.brand,
    standardModel: input.standardModel,
    category: input.category,
    searchQuery: input.searchQuery,
    version: input.version,
    mustIncludeTerms: input.mustIncludeTerms,
    excludedTerms: input.excludedTerms,
    comparisonType: input.comparisonType,
    colorComparable: input.colorComparable,
    owner: input.owner,
    notes: input.notes,
    bundleId
  };
}

function toRecord(model: LoadedModel): CatalogModelRecord {
  const listing = model.ownListings[0];
  if (!listing) {
    throw new Error(`Monitored model ${model.monitorCode} has no own listing`);
  }

  return {
    id: model.id,
    monitorCode: model.monitorCode,
    enabled: model.enabled,
    brand: model.brand,
    standardModel: model.standardModel,
    category: model.category,
    searchQuery: model.searchQuery,
    version: model.version,
    mustIncludeTerms: model.mustIncludeTerms,
    excludedTerms: model.excludedTerms,
    ownUrl: listing.url,
    ownSkuText: listing.skuText,
    comparisonType: model.comparisonType,
    bundleCode: model.bundle?.code ?? null,
    colorComparable: model.colorComparable,
    owner: model.owner,
    notes: model.notes
  };
}

export class PrismaCatalogRepository implements CatalogRepository {
  private readonly prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  async listModels(): Promise<CatalogModelRecord[]> {
    const models = await this.prisma.monitoredModel.findMany({
      include: modelInclude,
      orderBy: [{ brand: "asc" }, { standardModel: "asc" }, { monitorCode: "asc" }]
    });
    return models.map((model) => toRecord(model));
  }

  async findModelById(id: string): Promise<CatalogModelRecord | null> {
    const model = await this.prisma.monitoredModel.findUnique({
      where: { id },
      include: modelInclude
    });
    return model ? toRecord(model) : null;
  }

  async findModelByMonitorCode(monitorCode: string): Promise<CatalogModelRecord | null> {
    const model = await this.prisma.monitoredModel.findUnique({
      where: { monitorCode },
      include: modelInclude
    });
    return model ? toRecord(model) : null;
  }

  async findBundleIdByCode(code: string): Promise<string | null> {
    const bundle = await this.prisma.bundle.findUnique({ where: { code }, select: { id: true } });
    return bundle?.id ?? null;
  }

  async createModel(
    input: ValidatedCatalogModelInput,
    bundleId: string | null
  ): Promise<CatalogModelRecord> {
    const id = await this.prisma.$transaction(async (transaction) => {
      const model = await transaction.monitoredModel.create({ data: writeData(input, bundleId) });
      await transaction.ownListing.create({
        data: {
          monitoredModelId: model.id,
          platform: "TMALL",
          shopName: "星空乐器专营店",
          url: input.ownUrl,
          skuText: input.ownSkuText
        }
      });
      return model.id;
    });

    return (await this.findModelById(id))!;
  }

  async updateModel(
    id: string,
    input: ValidatedCatalogModelInput,
    bundleId: string | null
  ): Promise<CatalogModelRecord> {
    await this.prisma.$transaction(async (transaction) => {
      await transaction.monitoredModel.update({
        where: { id },
        data: writeData(input, bundleId)
      });
      await transaction.ownListing.updateMany({
        where: {
          monitoredModelId: id,
          active: true,
          NOT: { url: input.ownUrl, skuText: input.ownSkuText }
        },
        data: { active: false }
      });
      await transaction.ownListing.upsert({
        where: {
          monitoredModelId_url_skuText: {
            monitoredModelId: id,
            url: input.ownUrl,
            skuText: input.ownSkuText
          }
        },
        create: {
          monitoredModelId: id,
          platform: "TMALL",
          shopName: "星空乐器专营店",
          url: input.ownUrl,
          skuText: input.ownSkuText
        },
        update: { active: true, shopName: "星空乐器专营店", platform: "TMALL" }
      });
    });

    return (await this.findModelById(id))!;
  }

  async setModelEnabled(id: string, enabled: boolean): Promise<CatalogModelRecord> {
    await this.prisma.monitoredModel.update({ where: { id }, data: { enabled } });
    return (await this.findModelById(id))!;
  }

  async listBundlesForModel(id: string): Promise<CatalogBundleSummary[]> {
    const model = await this.prisma.monitoredModel.findUnique({
      where: { id },
      select: {
        bundle: {
          select: {
            code: true,
            title: true,
            items: {
              select: {
                accessoryType: true,
                brand: true,
                modelOrName: true,
                quantity: true,
                unitValueFen: true,
                core: true
              },
              orderBy: { createdAt: "asc" }
            }
          }
        }
      }
    });
    return model?.bundle ? [model.bundle] : [];
  }

  async listAliasesForModel(id: string): Promise<CatalogAliasSummary[]> {
    return this.prisma.modelAlias.findMany({
      where: { monitoredModelId: id },
      select: { phrase: true, type: true, notes: true },
      orderBy: [{ type: "asc" }, { phrase: "asc" }]
    });
  }
}
