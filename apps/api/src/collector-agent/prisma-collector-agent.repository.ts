import { collectorJobSchema, type CollectorJob } from "../../../../packages/contracts/src/index.ts";
import { Prisma, type PrismaClient } from "../../../../generated/prisma/client.ts";

import type { CollectorAgentRepository } from "./collector-agent.service.ts";
import { verifyCollectorToken } from "./collector-token.ts";

const maximumClaimAttempts = 5;
export const COLLECTOR_RUN_LEASE_MILLISECONDS = 90_000;

function isSerializableConflict(error: unknown): boolean {
  return typeof error === "object" && error !== null && Reflect.get(error, "code") === "P2034";
}

export class PrismaCollectorAgentRepository implements CollectorAgentRepository {
  private readonly prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  async createAgent(input: {
    name: string;
    platform: "MACOS" | "WINDOWS";
    tokenHash: string;
    actorId: string;
  }): Promise<{ id: string; name: string }> {
    void input.actorId;
    return this.prisma.collectorAgent.create({
      data: {
        name: input.name,
        platform: input.platform,
        tokenHash: input.tokenHash
      },
      select: { id: true, name: true }
    });
  }

  async authenticate(token: string): Promise<{ id: string; enabled: boolean } | null> {
    const agents = await this.prisma.collectorAgent.findMany({
      select: { id: true, enabled: true, tokenHash: true }
    });
    const agent = agents.find((entry) => verifyCollectorToken(token, entry.tokenHash));
    return agent ? { id: agent.id, enabled: agent.enabled } : null;
  }

  async claimNext(
    agentId: string,
    input: { appVersion: string; capabilities: string[] }
  ): Promise<CollectorJob | null> {
    for (let attempt = 0; attempt < maximumClaimAttempts; attempt += 1) {
      try {
        return await this.claimInSerializableTransaction(agentId, input);
      } catch (error) {
        if (!isSerializableConflict(error) || attempt === maximumClaimAttempts - 1) throw error;
      }
    }
    return null;
  }

  async heartbeat(
    agentId: string,
    runId: string,
    input: { discoveredCount: number; skuCount: number }
  ): Promise<boolean> {
    const now = new Date();
    const updated = await this.prisma.collectionRun.updateMany({
      where: { id: runId, collectorAgentId: agentId, status: "RUNNING" },
      data: {
        heartbeatAt: now,
        discoveredCount: input.discoveredCount,
        skuCount: input.skuCount
      }
    });
    if (updated.count === 0) return false;

    await this.prisma.collectorAgent.update({
      where: { id: agentId },
      data: { lastSeenAt: now }
    });
    return true;
  }

  async pause(
    agentId: string,
    runId: string,
    status: "PAUSED_LOGIN" | "PAUSED_CHALLENGE",
    code: "LOGIN_REQUIRED" | "PLATFORM_CHALLENGE",
    message: string
  ): Promise<boolean> {
    const now = new Date();
    const updated = await this.prisma.collectionRun.updateMany({
      where: { id: runId, collectorAgentId: agentId, status: "RUNNING" },
      data: {
        status,
        heartbeatAt: now,
        errorCode: code,
        errorMessage: message
      }
    });
    if (updated.count === 0) return false;

    await this.prisma.collectorAgent.update({
      where: { id: agentId },
      data: { lastSeenAt: now }
    });
    return true;
  }

  async release(agentId: string, runId: string): Promise<boolean> {
    const updated = await this.prisma.collectionRun.updateMany({
      where: { id: runId, collectorAgentId: agentId, status: "RUNNING" },
      data: {
        status: "QUEUED",
        heartbeatAt: new Date(),
        errorCode: null,
        errorMessage: null
      }
    });
    return updated.count === 1;
  }

  async ownsRun(agentId: string, runId: string): Promise<boolean> {
    return Boolean(await this.prisma.collectionRun.findFirst({
      where: { id: runId, collectorAgentId: agentId },
      select: { id: true }
    }));
  }

  private async claimInSerializableTransaction(
    agentId: string,
    input: { appVersion: string; capabilities: string[] }
  ): Promise<CollectorJob | null> {
    return this.prisma.$transaction(async (transaction) => {
      const now = new Date();
      const activeAgent = await transaction.collectorAgent.updateMany({
        where: { id: agentId, enabled: true },
        data: {
          appVersion: input.appVersion,
          capabilities: input.capabilities,
          lastSeenAt: now
        }
      });
      if (activeAgent.count === 0) return null;

      const staleBefore = new Date(now.getTime() - COLLECTOR_RUN_LEASE_MILLISECONDS);
      const staleOwnedRun = await transaction.collectionRun.findFirst({
        where: {
          status: "RUNNING",
          collectorAgentId: agentId,
          heartbeatAt: { lte: staleBefore },
          desktopReportDigest: null,
          monitoredModel: { ownListings: { some: { active: true } } }
        },
        orderBy: [{ heartbeatAt: "asc" }, { scheduledFor: "asc" }, { id: "asc" }],
        select: { id: true }
      });
      const nextRun = staleOwnedRun ?? await transaction.collectionRun.findFirst({
        where: {
          status: "QUEUED",
          OR: [{ collectorAgentId: null }, { collectorAgentId: agentId }],
          monitoredModel: { ownListings: { some: { active: true } } }
        },
        orderBy: [{ scheduledFor: "asc" }, { createdAt: "asc" }, { id: "asc" }],
        select: { id: true }
      });
      if (!nextRun) return null;

      const claimed = staleOwnedRun
        ? await transaction.collectionRun.updateMany({
            where: {
              id: nextRun.id,
              status: "RUNNING",
              collectorAgentId: agentId,
              heartbeatAt: { lte: staleBefore },
              desktopReportDigest: null
            },
            data: { claimedAt: now, heartbeatAt: now }
          })
        : await transaction.collectionRun.updateMany({
            where: {
              id: nextRun.id,
              status: "QUEUED",
              OR: [{ collectorAgentId: null }, { collectorAgentId: agentId }],
              monitoredModel: { ownListings: { some: { active: true } } }
            },
            data: {
              status: "RUNNING",
              collectorAgentId: agentId,
              claimedAt: now,
              heartbeatAt: now,
              startedAt: now,
              finishedAt: null,
              errorCode: null,
              errorMessage: null
            }
          });
      if (claimed.count === 0) return null;

      const run = await transaction.collectionRun.findUniqueOrThrow({
        where: { id: nextRun.id },
        select: {
          id: true,
          searchLimit: true,
          claimedJob: true,
          monitoredModel: {
            select: {
              id: true,
              brand: true,
              standardModel: true,
              version: true,
              comparisonType: true,
              searchQuery: true,
              mustIncludeTerms: true,
              excludedTerms: true,
              aliases: {
                select: { phrase: true, type: true },
                orderBy: [{ type: "asc" }, { phrase: "asc" }]
              },
              ownListings: {
                where: { active: true },
                select: { id: true, url: true, skuText: true, shopName: true },
                orderBy: [{ createdAt: "asc" }, { id: "asc" }]
              }
            }
          }
        }
      });

      if (run.claimedJob !== null) {
        const stored = collectorJobSchema.safeParse(run.claimedJob);
        if (!stored.success || stored.data.runId !== run.id || stored.data.collectorId !== agentId) {
          throw new Error("Stored collector job is invalid");
        }
        return stored.data;
      }

      const job = collectorJobSchema.parse({
        schemaVersion: 1,
        runId: run.id,
        collectorId: agentId,
        monitoredModelId: run.monitoredModel.id,
        searchQuery: run.monitoredModel.searchQuery,
        searchLimit: run.searchLimit,
        ownShopName: run.monitoredModel.ownListings[0]!.shopName,
        ownListings: run.monitoredModel.ownListings.map((listing) => ({
          id: listing.id,
          url: listing.url,
          skuText: listing.skuText
        })),
        rule: {
          brand: run.monitoredModel.brand,
          standardModel: run.monitoredModel.standardModel,
          version: run.monitoredModel.version,
          comparisonType: run.monitoredModel.comparisonType,
          effectiveAliases: run.monitoredModel.aliases
            .filter((alias) => alias.type === "EFFECTIVE")
            .map((alias) => alias.phrase),
          excludedAliases: run.monitoredModel.aliases
            .filter((alias) => alias.type === "EXCLUDED")
            .map((alias) => alias.phrase),
          mustIncludeTerms: run.monitoredModel.mustIncludeTerms,
          excludedTerms: run.monitoredModel.excludedTerms
        }
      });
      await transaction.collectionRun.update({
        where: { id: run.id },
        data: {
          claimedOwnListingIds: run.monitoredModel.ownListings.map((listing) => listing.id),
          claimedJob: JSON.parse(JSON.stringify(job)) as Prisma.InputJsonValue
        }
      });
      return job;
    }, { isolationLevel: "Serializable" });
  }
}
