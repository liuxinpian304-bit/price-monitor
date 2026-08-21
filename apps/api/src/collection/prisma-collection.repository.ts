import { Prisma, type PrismaClient } from "../../../../generated/prisma/client.ts";

import type {
  CollectedOfferInput,
  CollectionModel,
  CollectionRepository,
  CollectionSummary
} from "./collection.service.ts";

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export class PrismaCollectionRepository implements CollectionRepository {
  private readonly prisma: PrismaClient;
  private readonly providerKey: string;

  constructor(prisma: PrismaClient, providerKey: string) {
    this.prisma = prisma;
    this.providerKey = providerKey;
  }

  async getModel(id: string): Promise<CollectionModel | null> {
    const model = await this.prisma.monitoredModel.findUnique({
      where: { id },
      include: { aliases: { select: { phrase: true, type: true } } }
    });
    if (!model || !model.enabled) {
      return null;
    }

    return {
      id: model.id,
      providerKey: this.providerKey,
      searchQuery: model.searchQuery,
      rule: {
        brand: model.brand,
        standardModel: model.standardModel,
        version: model.version,
        comparisonType: model.comparisonType,
        effectiveAliases: model.aliases
          .filter((alias) => alias.type === "EFFECTIVE")
          .map((alias) => alias.phrase),
        excludedAliases: model.aliases
          .filter((alias) => alias.type === "EXCLUDED")
          .map((alias) => alias.phrase),
        mustIncludeTerms: model.mustIncludeTerms,
        excludedTerms: model.excludedTerms
      }
    };
  }

  async getCompletedSummary(runId: string): Promise<CollectionSummary | null> {
    const run = await this.prisma.collectionRun.findUnique({ where: { id: runId } });
    if (!run || (run.status !== "SUCCEEDED" && run.status !== "PARTIAL_FAILED")) {
      return null;
    }
    return {
      searched: run.searchedCount,
      fetched: run.fetchedCount,
      matched: run.matchedCount,
      failed: run.failedCount
    };
  }

  async startRun(runId: string, model: CollectionModel): Promise<void> {
    const now = new Date();
    await this.prisma.collectionRun.upsert({
      where: { id: runId },
      create: {
        id: runId,
        monitoredModelId: model.id,
        providerKey: model.providerKey,
        status: "RUNNING",
        scheduledFor: now,
        startedAt: now
      },
      update: {
        status: "RUNNING",
        startedAt: now,
        finishedAt: null,
        errorCode: null,
        errorMessage: null
      }
    });
  }

  async saveOffer(input: CollectedOfferInput): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      const candidate = await transaction.searchCandidate.upsert({
        where: {
          monitoredModelId_providerKey_platformItemId: {
            monitoredModelId: input.model.id,
            providerKey: input.model.providerKey,
            platformItemId: input.offer.platformItemId
          }
        },
        create: {
          monitoredModelId: input.model.id,
          providerKey: input.model.providerKey,
          platformItemId: input.offer.platformItemId,
          url: input.offer.url,
          shopName: input.offer.shopName,
          title: input.offer.title,
          decision: input.match.category,
          comparable: input.match.comparable,
          confidenceBps: Math.round(input.match.confidence * 10_000),
          normalizedModel: input.match.normalizedModel,
          reasons: toJson(input.match.reasons),
          lastSeenAt: input.offer.capturedAt
        },
        update: {
          url: input.offer.url,
          shopName: input.offer.shopName,
          title: input.offer.title,
          decision: input.match.category,
          comparable: input.match.comparable,
          confidenceBps: Math.round(input.match.confidence * 10_000),
          normalizedModel: input.match.normalizedModel,
          reasons: toJson(input.match.reasons),
          lastSeenAt: input.offer.capturedAt
        }
      });

      const selectedSku = input.offer.skuOptions.find((sku) => sku.skuId === input.offer.selectedSkuId);
      await transaction.offerSnapshot.create({
        data: {
          collectionRunId: input.runId,
          searchCandidateId: candidate.id,
          platformItemId: input.offer.platformItemId,
          skuId: input.offer.selectedSkuId,
          shopName: input.offer.shopName,
          title: input.offer.title,
          skuText: selectedSku?.label ?? null,
          listPriceFen: input.offer.listPriceFen,
          publicDiscountFen: input.price.publicDiscountFen,
          payableFen: input.price.payableFen,
          stockState: input.offer.stockState,
          promotions: toJson(input.offer.promotions),
          gifts: toJson(input.offer.gifts),
          rawEvidence: toJson(input.offer.rawEvidence),
          evidenceUrl: input.offer.evidenceUrl,
          capturedAt: input.offer.capturedAt
        }
      });
    });
  }

  async recordItemFailure(runId: string, _url: string, message: string): Promise<void> {
    await this.prisma.collectionRun.update({
      where: { id: runId },
      data: { errorCode: "ITEM_FAILURE", errorMessage: message }
    });
  }

  async recordSystemError(runId: string, code: string, message: string): Promise<void> {
    await this.prisma.collectionRun.update({
      where: { id: runId },
      data: { errorCode: code, errorMessage: message }
    });
  }

  async finishRun(
    runId: string,
    status: "SUCCEEDED" | "PARTIAL_FAILED" | "FAILED",
    summary: CollectionSummary
  ): Promise<void> {
    await this.prisma.collectionRun.update({
      where: { id: runId },
      data: {
        status,
        searchedCount: summary.searched,
        fetchedCount: summary.fetched,
        matchedCount: summary.matched,
        failedCount: summary.failed,
        finishedAt: new Date()
      }
    });
  }
}
