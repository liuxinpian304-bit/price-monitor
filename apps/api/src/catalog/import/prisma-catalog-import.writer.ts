import { Prisma, type PrismaClient } from "../../../../../generated/prisma/client.ts";

import type {
  CatalogImportWriter,
  ValidatedCatalogImport,
  ValidatedModelImport
} from "./catalog-import.service.ts";

function modelIdentity(brand: string, standardModel: string): string {
  return `${brand.trim().toLocaleLowerCase()}\u0000${standardModel.trim().toLocaleLowerCase()}`;
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function modelData(model: ValidatedModelImport, bundleId: string | null) {
  return {
    enabled: model.enabled,
    brand: model.brand,
    standardModel: model.standardModel,
    category: model.category,
    searchQuery: model.searchQuery,
    version: model.version,
    mustIncludeTerms: model.mustIncludeTerms,
    excludedTerms: model.excludedTerms,
    comparisonType: model.comparisonType,
    colorComparable: model.colorComparable,
    owner: model.owner,
    notes: model.notes,
    bundleId
  };
}

export class PrismaCatalogImportWriter implements CatalogImportWriter {
  private readonly prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  async importAtomically(
    catalog: ValidatedCatalogImport,
    actorId: string
  ): Promise<{ imported: number; updated: number }> {
    return this.prisma.$transaction(async (transaction) => {
      const bundleIds = new Map<string, string>();

      for (const bundle of catalog.bundles) {
        const storedBundle = await transaction.bundle.upsert({
          where: { code: bundle.code },
          create: {
            code: bundle.code,
            title: `${bundle.mainBrand} ${bundle.mainModel}`
          },
          update: {
            title: `${bundle.mainBrand} ${bundle.mainModel}`
          }
        });
        bundleIds.set(bundle.code, storedBundle.id);

        await transaction.bundleItem.deleteMany({ where: { bundleId: storedBundle.id } });
        await transaction.bundleItem.createMany({
          data: bundle.items.map((item) => ({
            bundleId: storedBundle.id,
            accessoryType: item.accessoryType,
            brand: item.accessoryBrand,
            modelOrName: item.modelOrName,
            quantity: item.quantity,
            unitValueFen: item.unitValueFen,
            core: item.core,
            notes: item.notes
          }))
        });
      }

      let imported = 0;
      let updated = 0;

      for (const model of catalog.models) {
        const before = await transaction.monitoredModel.findUnique({
          where: { monitorCode: model.monitorCode },
          include: { aliases: true, ownListings: true }
        });
        const bundleId = model.bundleCode === null ? null : bundleIds.get(model.bundleCode) ?? null;
        const data = modelData(model, bundleId);
        const storedModel = await transaction.monitoredModel.upsert({
          where: { monitorCode: model.monitorCode },
          create: { monitorCode: model.monitorCode, ...data },
          update: data
        });

        if (before) {
          updated += 1;
        } else {
          imported += 1;
        }

        await transaction.ownListing.updateMany({
          where: {
            monitoredModelId: storedModel.id,
            active: true,
            NOT: {
              url: model.ownListing.url,
              skuText: model.ownListing.skuText
            }
          },
          data: { active: false }
        });
        await transaction.ownListing.upsert({
          where: {
            monitoredModelId_url_skuText: {
              monitoredModelId: storedModel.id,
              url: model.ownListing.url,
              skuText: model.ownListing.skuText
            }
          },
          create: {
            monitoredModelId: storedModel.id,
            platform: model.ownListing.platform,
            shopName: model.ownListing.shopName,
            url: model.ownListing.url,
            skuText: model.ownListing.skuText
          },
          update: {
            platform: model.ownListing.platform,
            shopName: model.ownListing.shopName,
            active: true
          }
        });

        await transaction.modelAlias.deleteMany({ where: { monitoredModelId: storedModel.id } });
        const aliases = catalog.aliases.filter((alias) =>
          modelIdentity(alias.brand, alias.standardModel) === modelIdentity(model.brand, model.standardModel)
        );
        if (aliases.length > 0) {
          await transaction.modelAlias.createMany({
            data: aliases.map((alias) => ({
              monitoredModelId: storedModel.id,
              phrase: alias.phrase,
              type: alias.type,
              notes: alias.notes
            }))
          });
        }

        await transaction.auditLog.create({
          data: {
            actorId,
            action: before ? "catalog.model.updated" : "catalog.model.imported",
            entityType: "MonitoredModel",
            entityId: storedModel.id,
            ...(before ? { before: toJson(before) } : {}),
            after: toJson({
              ...model,
              id: storedModel.id,
              bundleId
            })
          }
        });
      }

      return { imported, updated };
    });
  }
}
