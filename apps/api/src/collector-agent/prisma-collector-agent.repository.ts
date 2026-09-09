import {
  collectorJobSchema,
  type CollectorClaimInput,
  type CollectorJob,
  type CollectorRunReleaseInput
} from "../../../../packages/contracts/src/index.ts";
import { Prisma, type PrismaClient } from "../../../../generated/prisma/client.ts";

import type { CollectorAgentRepository } from "./collector-agent.service.ts";
import { reconcileCollectorSessionIncident } from "./collector-session-incident.repository.ts";
import { verifyCollectorToken } from "./collector-token.ts";

const maximumSerializableAttempts = 5;
export const COLLECTOR_RUN_LEASE_MILLISECONDS = 90_000;

const PROVIDER_PROFILES = [{
  providerKey: "taobao-desktop",
  platform: "MACOS",
  capabilities: ["accessibility", "all-sku", "png-evidence"]
}] as const;

function compatibleProviderKeys(platform: "MACOS" | "WINDOWS", capabilities: string[]): string[] {
  const advertised = new Set(capabilities);
  return PROVIDER_PROFILES.filter((profile) => profile.platform === platform
    && profile.capabilities.every((capability) => advertised.has(capability)))
    .map((profile) => profile.providerKey);
}

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
    input: CollectorClaimInput
  ): Promise<CollectorJob | null> {
    for (let attempt = 0; attempt < maximumSerializableAttempts; attempt += 1) {
      try {
        return await this.claimInSerializableTransaction(agentId, input);
      } catch (error) {
        if (!isSerializableConflict(error) || attempt === maximumSerializableAttempts - 1) throw error;
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
    message: string,
    observedAt: Date = new Date()
  ): Promise<boolean> {
    for (let attempt = 0; attempt < maximumSerializableAttempts; attempt += 1) {
      try {
        return await this.pauseInSerializableTransaction(
          agentId,
          runId,
          status,
          code,
          message,
          observedAt
        );
      } catch (error) {
        if (!isSerializableConflict(error) || attempt === maximumSerializableAttempts - 1) throw error;
      }
    }
    return false;
  }

  private async pauseInSerializableTransaction(
    agentId: string,
    runId: string,
    status: "PAUSED_LOGIN" | "PAUSED_CHALLENGE",
    code: "LOGIN_REQUIRED" | "PLATFORM_CHALLENGE",
    message: string,
    observedAt: Date
  ): Promise<boolean> {
    return this.prisma.$transaction(async (transaction) => {
      const updated = await transaction.collectionRun.updateMany({
        where: { id: runId, collectorAgentId: agentId, status: "RUNNING" },
        data: {
          status,
          heartbeatAt: observedAt,
          errorCode: code,
          errorMessage: message
        }
      });
      if (updated.count === 0) return false;

      const agent = await transaction.collectorAgent.findUnique({
        where: { id: agentId },
        select: { sessionState: true }
      });
      const sessionState = code === "LOGIN_REQUIRED" ? "LOGIN_REQUIRED" : "CHALLENGE_REQUIRED";
      await transaction.collectorAgent.update({
        where: { id: agentId },
        data: {
          lastSeenAt: observedAt,
          sessionState,
          sessionObservedAt: observedAt,
          ...(agent?.sessionState === sessionState ? {} : { sessionChangedAt: observedAt })
        }
      });
      await reconcileCollectorSessionIncident(
        transaction,
        agentId,
        agent?.sessionState ?? "UNAVAILABLE",
        sessionState,
        observedAt
      );
      return true;
    }, { isolationLevel: "Serializable" });
  }

  async release(
    agentId: string,
    runId: string,
    input: CollectorRunReleaseInput
  ): Promise<boolean> {
    const now = new Date();
    const updated = await this.prisma.collectionRun.updateMany({
      where: { id: runId, collectorAgentId: agentId, status: "RUNNING" },
      data: input.disposition === "QUARANTINE" ? {
        status: "FAILED",
        heartbeatAt: now,
        finishedAt: now,
        errorCode: input.errorCode,
        errorMessage: "Collector checkpoint requires operator review"
      } : {
        status: "QUEUED",
        heartbeatAt: now,
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
    input: CollectorClaimInput
  ): Promise<CollectorJob | null> {
    return this.prisma.$transaction(async (transaction) => {
      const now = new Date();
      const agentProfile = await transaction.collectorAgent.findFirst({
        where: { id: agentId, enabled: true },
        select: { platform: true, sessionState: true, sessionObservedAt: true }
      });
      if (!agentProfile) return null;
      const observedAt = new Date(input.session.observedAt);
      const acceptsObservation = agentProfile.sessionObservedAt === null
        || observedAt.getTime() > agentProfile.sessionObservedAt.getTime();
      const effectiveSessionState = acceptsObservation
        ? input.session.state
        : agentProfile.sessionState;
      const activeAgent = await transaction.collectorAgent.updateMany({
        where: { id: agentId, enabled: true },
        data: {
          appVersion: input.appVersion,
          capabilities: input.capabilities,
          lastSeenAt: now,
          ...(acceptsObservation ? {
            sessionState: input.session.state,
            sessionObservedAt: observedAt,
            ...(agentProfile.sessionState === input.session.state ? {} : { sessionChangedAt: now })
          } : {})
        }
      });
      if (activeAgent.count === 0) return null;
      if (acceptsObservation) {
        await reconcileCollectorSessionIncident(
          transaction,
          agentId,
          agentProfile.sessionState,
          input.session.state,
          observedAt
        );
      }
      if (effectiveSessionState !== "READY") return null;
      const providerKeys = compatibleProviderKeys(agentProfile.platform, input.capabilities);
      if (providerKeys.length === 0) return null;

      const staleBefore = new Date(now.getTime() - COLLECTOR_RUN_LEASE_MILLISECONDS);
      const activeOwnedRun = await transaction.collectionRun.findFirst({
        where: {
          status: "RUNNING",
          collectorAgentId: agentId,
          heartbeatAt: { gt: staleBefore },
          desktopReportDigest: null
        },
        select: { id: true }
      });
      if (activeOwnedRun) return null;

      const staleOwnedRun = await transaction.collectionRun.findFirst({
        where: {
          providerKey: { in: providerKeys },
          status: "RUNNING",
          collectorAgentId: agentId,
          OR: [{ heartbeatAt: null }, { heartbeatAt: { lte: staleBefore } }],
          desktopReportDigest: null,
          monitoredModel: { ownListings: { some: { active: true } } }
        },
        orderBy: [{ heartbeatAt: "asc" }, { scheduledFor: "asc" }, { id: "asc" }],
        select: { id: true }
      });

      const pausedOwnedRun = staleOwnedRun ? null : await transaction.collectionRun.findFirst({
        where: {
          providerKey: { in: providerKeys },
          status: { in: ["PAUSED_LOGIN", "PAUSED_CHALLENGE"] },
          collectorAgentId: agentId,
          desktopReportDigest: null,
          monitoredModel: { ownListings: { some: { active: true } } }
        },
        orderBy: [{ scheduledFor: "asc" }, { createdAt: "asc" }, { id: "asc" }],
        select: { id: true }
      });
      const queuedRun = staleOwnedRun || pausedOwnedRun ? null : await transaction.collectionRun.findFirst({
        where: {
          providerKey: { in: providerKeys },
          status: "QUEUED",
          OR: [{ collectorAgentId: null }, { collectorAgentId: agentId }],
          monitoredModel: { ownListings: { some: { active: true } } }
        },
        orderBy: [{ scheduledFor: "asc" }, { createdAt: "asc" }, { id: "asc" }],
        select: { id: true }
      });
      const nextRun = staleOwnedRun ?? pausedOwnedRun ?? queuedRun;
      if (!nextRun) return null;

      const claimed = staleOwnedRun
        ? await transaction.collectionRun.updateMany({
            where: {
              id: nextRun.id,
              providerKey: { in: providerKeys },
              status: "RUNNING",
              collectorAgentId: agentId,
              OR: [{ heartbeatAt: null }, { heartbeatAt: { lte: staleBefore } }],
              desktopReportDigest: null
            },
            data: { claimedAt: now, heartbeatAt: now }
          })
        : pausedOwnedRun
          ? await transaction.collectionRun.updateMany({
              where: {
                id: nextRun.id,
                providerKey: { in: providerKeys },
                status: { in: ["PAUSED_LOGIN", "PAUSED_CHALLENGE"] },
                collectorAgentId: agentId,
                desktopReportDigest: null
              },
              data: {
                status: "RUNNING",
                claimedAt: now,
                heartbeatAt: now,
                finishedAt: null,
                errorCode: null,
                errorMessage: null
              }
            })
          : await transaction.collectionRun.updateMany({
            where: {
              id: nextRun.id,
              providerKey: { in: providerKeys },
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
              colorComparable: true,
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
          colorComparable: run.monitoredModel.colorComparable,
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
