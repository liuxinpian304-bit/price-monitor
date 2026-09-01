import { createHash } from "node:crypto";

import type {
  CollectedItem,
  CollectedSku,
  CollectorIssue,
  CollectorReport
} from "../../../../packages/contracts/src/index.ts";
import { collectorJobSchema } from "../../../../packages/contracts/src/index.ts";
import { Prisma, type PrismaClient } from "../../../../generated/prisma/client.ts";
import { RUN_ALERT_EVALUATION_VERSION } from "../alerts/run-alert-evaluation-version.ts";

import {
  desktopReportDigest,
  DesktopReportConflictError,
  DesktopReportValidationError,
  ingestionSummarySchema,
  type ClaimedDesktopRun,
  type DesktopReportRepository,
  type IngestionSummary,
  type TerminalCollectionStatus
} from "./desktop-report-ingestion.service.ts";

type Transaction = Prisma.TransactionClient;

function isTerminalStatus(status: string): status is TerminalCollectionStatus {
  return status === "SUCCEEDED" || status === "PARTIAL_FAILED" || status === "FAILED";
}

function sha256(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function snapshotIngestionKey(
  runId: string,
  identityKind: "own-listing" | "candidate",
  identityId: string,
  platformItemId: string,
  skuId: string,
  capturedAt: string
): string {
  return sha256([runId, identityKind, identityId, platformItemId, skuId, capturedAt]);
}

function issueIngestionKey(runId: string, issue: CollectorIssue, index: number): string {
  return sha256([
    runId,
    "issue",
    index,
    issue.code,
    issue.platformItemId ?? null,
    issue.skuId ?? null,
    issue.message,
    issue.evidenceKey ?? null,
    issue.capturedAt
  ]);
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function snapshotValues(input: {
  runId: string;
  item: CollectedItem;
  sku: CollectedSku;
  ownListingId: string | null;
  searchCandidateId: string | null;
  ingestionKey: string;
}) {
  return {
    collectionRunId: input.runId,
    ownListingId: input.ownListingId,
    searchCandidateId: input.searchCandidateId,
    platformItemId: input.item.platformItemId,
    skuId: input.sku.skuId,
    shopName: input.item.shopName,
    title: input.item.title,
    skuText: input.sku.label,
    listPriceFen: input.sku.listPriceFen,
    activityPriceFen: input.sku.activityPriceFen,
    couponDiscountFen: input.sku.couponDiscountFen,
    fullReductionFen: input.sku.fullReductionFen,
    directDiscountFen: input.sku.directDiscountFen,
    mandatoryFeeFen: input.sku.mandatoryFeeFen,
    publicDiscountFen: input.sku.couponDiscountFen
      + input.sku.fullReductionFen
      + input.sku.directDiscountFen,
    payableFen: input.sku.payableFen,
    priceConfidence: input.sku.priceConfidence,
    evidenceKey: input.sku.evidenceKey,
    ingestionKey: input.ingestionKey,
    matchDecision: null,
    comparable: false,
    matchConfidenceBps: 0,
    normalizedModel: null,
    matchReasons: Prisma.DbNull,
    stockState: input.sku.stockState,
    promotions: toJson(input.sku.promotions),
    gifts: toJson([]),
    rawEvidence: toJson({
      source: "taobao-desktop",
      attributes: input.sku.attributes,
      ...(input.sku.components === undefined ? {} : { components: input.sku.components })
    }),
    evidenceUrl: null,
    capturedAt: new Date(input.sku.capturedAt)
  };
}

function expectedCounters(report: CollectorReport) {
  const skuCount = [...report.ownItems, ...report.competitorItems]
    .reduce((count, item) => count + item.skus.length, 0);
  return {
    searchedCount: report.positions.length,
    fetchedCount: report.ownItems.length + report.competitorItems.length,
    matchedCount: 0,
    failedCount: report.issues.length,
    discoveredCount: report.positions.length,
    skuCount,
    incompleteCount: report.issues.length
  };
}

export class PrismaDesktopReportRepository implements DesktopReportRepository {
  private readonly prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  async inspectRun(agentId: string, runId: string): Promise<ClaimedDesktopRun | null> {
    const run = await this.prisma.collectionRun.findFirst({
      where: { id: runId, collectorAgentId: agentId },
      select: {
        id: true,
        collectorAgentId: true,
        monitoredModelId: true,
        providerKey: true,
        searchLimit: true,
        status: true,
        claimedOwnListingIds: true,
        claimedJob: true
      }
    });
    if (!run?.collectorAgentId) return null;
    const claimedJob = collectorJobSchema.safeParse(run.claimedJob);
    if (!claimedJob.success || claimedJob.data.runId !== run.id
      || claimedJob.data.collectorId !== run.collectorAgentId) return null;
    return {
      runId: run.id,
      agentId: run.collectorAgentId,
      monitoredModelId: run.monitoredModelId,
      providerKey: run.providerKey,
      searchLimit: run.searchLimit,
      status: run.status,
      ownListingIds: run.claimedOwnListingIds,
      ownListings: claimedJob.data.ownListings.map((listing) => ({
        id: listing.id,
        url: listing.url,
        shopName: claimedJob.data.ownShopName
      }))
    };
  }

  async withEvidenceRunLock<T>(
    agentId: string,
    runId: string,
    operation: (mode: "CREATE_OR_REPLAY" | "REPLAY_ONLY") => Promise<T>
  ): Promise<T> {
    return this.prisma.$transaction(async (transaction) => {
      const locked = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id"
        FROM "CollectionRun"
        WHERE "id" = ${runId}
        FOR UPDATE
      `);
      if (locked.length !== 1) throw new DesktopReportConflictError();

      const run = await transaction.collectionRun.findUniqueOrThrow({
        where: { id: runId },
        select: { collectorAgentId: true, status: true }
      });
      if (run.collectorAgentId !== agentId) throw new DesktopReportConflictError();
      if (run.status === "RUNNING") return operation("CREATE_OR_REPLAY");
      if (isTerminalStatus(run.status)) return operation("REPLAY_ONLY");
      throw new DesktopReportConflictError();
    }, { isolationLevel: "ReadCommitted", maxWait: 10_000, timeout: 30_000 });
  }

  async ingest(
    agentId: string,
    report: CollectorReport,
    verifyEvidence: () => Promise<void>
  ): Promise<{ summary: IngestionSummary; newlyAccepted: boolean }> {
    if (!isTerminalStatus(report.status)) throw new DesktopReportValidationError();
    const reportDigest = desktopReportDigest(report);
    return this.prisma.$transaction(async (transaction) => {
      const locked = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id"
        FROM "CollectionRun"
        WHERE "id" = ${report.runId}
        FOR UPDATE
      `);
      if (locked.length !== 1) throw new DesktopReportConflictError();

      const run = await transaction.collectionRun.findUniqueOrThrow({
        where: { id: report.runId },
        select: {
          collectorAgentId: true,
          monitoredModelId: true,
          providerKey: true,
          searchLimit: true,
          status: true,
          claimedOwnListingIds: true,
          desktopReportDigest: true,
          desktopIngestionSummary: true
        }
      });
      this.assertClaim(run, agentId, report);

      if (run.status !== "RUNNING") {
        if (!isTerminalStatus(run.status)) throw new DesktopReportConflictError();
        const storedSummary = ingestionSummarySchema.safeParse(run.desktopIngestionSummary);
        if (run.desktopReportDigest !== reportDigest
          || !storedSummary.success
          || storedSummary.data.runId !== report.runId
          || storedSummary.data.status !== report.status) {
          throw new DesktopReportConflictError();
        }
        await verifyEvidence();
        return {
          summary: storedSummary.data,
          newlyAccepted: false
        };
      }

      await verifyEvidence();
      await this.persistPositions(transaction, report);
      const candidates = await this.persistCandidates(transaction, run.monitoredModelId, run.providerKey, report);
      await this.persistSnapshots(transaction, report, candidates);
      await this.persistIssues(transaction, report);

      const counters = expectedCounters(report);
      await transaction.collectionRun.update({
        where: { id: report.runId },
        data: {
          status: report.status,
          startedAt: new Date(report.startedAt),
          finishedAt: new Date(report.completedAt),
          heartbeatAt: new Date(report.completedAt),
          searchTerminationReason: report.searchTerminationReason ?? null,
          ...counters,
          desktopReportDigest: reportDigest,
          alertEvaluationVersion: RUN_ALERT_EVALUATION_VERSION,
          errorCode: null,
          errorMessage: null
        }
      });

      const summary = await this.summary(transaction, report.runId);
      await transaction.collectionRun.update({
        where: { id: report.runId },
        data: { desktopIngestionSummary: toJson(summary) }
      });

      return {
        summary,
        newlyAccepted: true
      };
    }, { isolationLevel: "ReadCommitted", maxWait: 10_000, timeout: 30_000 });
  }

  async recordSystemError(
    agentId: string,
    runId: string,
    code: string,
    message: string
  ): Promise<void> {
    await this.prisma.collectionRun.updateMany({
      where: { id: runId, collectorAgentId: agentId, status: "RUNNING" },
      data: { errorCode: code, errorMessage: message }
    });
  }

  private assertClaim(
    run: {
      collectorAgentId: string | null;
      searchLimit: number;
      claimedOwnListingIds: string[];
    },
    agentId: string,
    report: CollectorReport
  ): void {
    if (
      run.collectorAgentId !== agentId
      || report.collectorId !== agentId
      || report.searchLimit !== run.searchLimit
      || report.positions.length > run.searchLimit
    ) {
      throw new DesktopReportConflictError();
    }
    const ownListingIds = new Set(run.claimedOwnListingIds);
    const reportedOwnListingIds = new Set(report.ownItems.map((item) => item.ownListingId));
    if (report.ownItems.some((item) => !ownListingIds.has(item.ownListingId))
      || (report.status === "SUCCEEDED"
        && (ownListingIds.size === 0
          || reportedOwnListingIds.size === 0
          || reportedOwnListingIds.size !== ownListingIds.size
          || [...ownListingIds].some((id) => !reportedOwnListingIds.has(id))))) {
      throw new DesktopReportConflictError();
    }
  }

  private async persistPositions(transaction: Transaction, report: CollectorReport): Promise<void> {
    for (const position of report.positions) {
      const values = {
        collectionRunId: report.runId,
        rank: position.rank,
        platformItemId: position.platformItemId,
        url: position.url,
        shopName: position.shopName,
        title: position.title,
        displayPriceMinFen: position.displayPriceMinFen,
        displayPriceMaxFen: position.displayPriceMaxFen,
        sponsored: position.sponsored,
        capturedAt: new Date(position.capturedAt)
      };
      await transaction.collectionSearchPosition.upsert({
        where: { collectionRunId_rank: { collectionRunId: report.runId, rank: position.rank } },
        create: values,
        update: values
      });
    }
  }

  private async persistCandidates(
    transaction: Transaction,
    monitoredModelId: string,
    providerKey: string,
    report: CollectorReport
  ): Promise<Map<string, string>> {
    const candidates = new Map<string, string>();
    for (const item of report.competitorItems) {
      const candidate = await transaction.searchCandidate.upsert({
        where: {
          monitoredModelId_providerKey_platformItemId: {
            monitoredModelId,
            providerKey,
            platformItemId: item.platformItemId
          }
        },
        create: {
          monitoredModelId,
          providerKey,
          platformItemId: item.platformItemId,
          url: item.url,
          shopName: item.shopName,
          title: item.title,
          decision: "PENDING",
          comparable: false,
          confidenceBps: 0,
          normalizedModel: null,
          reasons: Prisma.DbNull,
          lastSeenAt: new Date(report.completedAt)
        },
        update: {
          url: item.url,
          shopName: item.shopName,
          title: item.title,
          decision: "PENDING",
          comparable: false,
          confidenceBps: 0,
          normalizedModel: null,
          reasons: Prisma.DbNull,
          lastSeenAt: new Date(report.completedAt)
        },
        select: { id: true }
      });
      candidates.set(item.platformItemId, candidate.id);
    }
    return candidates;
  }

  private async persistSnapshots(
    transaction: Transaction,
    report: CollectorReport,
    candidates: Map<string, string>
  ): Promise<void> {
    for (const item of report.ownItems) {
      for (const sku of item.skus) {
        const ingestionKey = snapshotIngestionKey(
          report.runId,
          "own-listing",
          item.ownListingId,
          item.platformItemId,
          sku.skuId,
          sku.capturedAt
        );
        const values = snapshotValues({
          runId: report.runId,
          item,
          sku,
          ownListingId: item.ownListingId,
          searchCandidateId: null,
          ingestionKey
        });
        await transaction.offerSnapshot.upsert({
          where: { ingestionKey },
          create: values,
          update: values
        });
      }
    }

    for (const item of report.competitorItems) {
      const candidateId = candidates.get(item.platformItemId);
      if (!candidateId) throw new DesktopReportConflictError();
      for (const sku of item.skus) {
        const ingestionKey = snapshotIngestionKey(
          report.runId,
          "candidate",
          candidateId,
          item.platformItemId,
          sku.skuId,
          sku.capturedAt
        );
        const values = snapshotValues({
          runId: report.runId,
          item,
          sku,
          ownListingId: null,
          searchCandidateId: candidateId,
          ingestionKey
        });
        await transaction.offerSnapshot.upsert({
          where: { ingestionKey },
          create: values,
          update: values
        });
      }
    }
  }

  private async persistIssues(transaction: Transaction, report: CollectorReport): Promise<void> {
    for (const [index, issue] of report.issues.entries()) {
      const issueKey = issueIngestionKey(report.runId, issue, index);
      const values = {
        collectionRunId: report.runId,
        issueKey,
        code: issue.code,
        platformItemId: issue.platformItemId ?? null,
        skuId: issue.skuId ?? null,
        message: issue.message,
        evidenceKey: issue.evidenceKey ?? null,
        capturedAt: new Date(issue.capturedAt)
      };
      await transaction.collectionIssue.upsert({
        where: { issueKey },
        create: values,
        update: values
      });
    }
  }

  private async summary(transaction: Transaction, runId: string): Promise<IngestionSummary> {
    const run = await transaction.collectionRun.findUniqueOrThrow({
      where: { id: runId },
      select: { status: true, searchedCount: true, skuCount: true, failedCount: true }
    });
    if (!isTerminalStatus(run.status)) throw new DesktopReportConflictError();
    const positions = await transaction.collectionSearchPosition.findMany({
      where: { collectionRunId: runId },
      select: { platformItemId: true }
    });
    const snapshots = await transaction.offerSnapshot.findMany({
      where: { collectionRunId: runId },
      select: { id: true, ownListingId: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }]
    });
    return {
      runId,
      status: run.status,
      positionCount: run.searchedCount,
      uniqueItemCount: new Set(positions.map((position) => position.platformItemId)).size,
      skuCount: run.skuCount,
      issueCount: run.failedCount,
      ownSnapshotIds: snapshots.filter((snapshot) => snapshot.ownListingId !== null).map((snapshot) => snapshot.id),
      competitorSnapshotIds: snapshots.filter((snapshot) => snapshot.ownListingId === null).map((snapshot) => snapshot.id)
    };
  }

}
