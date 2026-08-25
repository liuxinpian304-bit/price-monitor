import { createHash } from "node:crypto";

import type {
  CollectedItem,
  CollectedSku,
  CollectorIssue,
  CollectorReport
} from "../../../../packages/contracts/src/index.ts";
import { Prisma, type PrismaClient } from "../../../../generated/prisma/client.ts";

import {
  DesktopReportConflictError,
  DesktopReportValidationError,
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

function jsonValue(value: unknown): string {
  const normalize = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(normalize);
    if (entry && typeof entry === "object") {
      return Object.fromEntries(
        Object.entries(entry as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, nested]) => [key, normalize(nested)])
      );
    }
    return entry;
  };
  return JSON.stringify(normalize(value));
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
      attributes: input.sku.attributes
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
        claimedOwnListingIds: true
      }
    });
    if (!run?.collectorAgentId) return null;
    return {
      runId: run.id,
      agentId: run.collectorAgentId,
      monitoredModelId: run.monitoredModelId,
      providerKey: run.providerKey,
      searchLimit: run.searchLimit,
      status: run.status,
      ownListingIds: run.claimedOwnListingIds
    };
  }

  async ingest(
    agentId: string,
    report: CollectorReport
  ): Promise<{ summary: IngestionSummary; newlyAccepted: boolean }> {
    if (!isTerminalStatus(report.status)) throw new DesktopReportValidationError();
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
          id: true,
          collectorAgentId: true,
          monitoredModelId: true,
          providerKey: true,
          searchLimit: true,
          status: true,
          startedAt: true,
          finishedAt: true,
          searchedCount: true,
          fetchedCount: true,
          matchedCount: true,
          failedCount: true,
          discoveredCount: true,
          skuCount: true,
          incompleteCount: true,
          claimedOwnListingIds: true
        }
      });
      this.assertClaim(run, agentId, report);

      if (run.status !== "RUNNING") {
        if (!isTerminalStatus(run.status) || !await this.matchesPersistedReport(transaction, run, report)) {
          throw new DesktopReportConflictError();
        }
        return {
          summary: await this.summary(transaction, report.runId),
          newlyAccepted: false
        };
      }

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
          ...counters,
          errorCode: null,
          errorMessage: null
        }
      });

      return {
        summary: await this.summary(transaction, report.runId),
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
    if (report.ownItems.some((item) => !ownListingIds.has(item.ownListingId))) {
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
      select: { status: true }
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
    const issueCount = await transaction.collectionIssue.count({ where: { collectionRunId: runId } });
    return {
      runId,
      status: run.status,
      positionCount: positions.length,
      uniqueItemCount: new Set(positions.map((position) => position.platformItemId)).size,
      skuCount: snapshots.length,
      issueCount,
      ownSnapshotIds: snapshots.filter((snapshot) => snapshot.ownListingId !== null).map((snapshot) => snapshot.id),
      competitorSnapshotIds: snapshots.filter((snapshot) => snapshot.ownListingId === null).map((snapshot) => snapshot.id)
    };
  }

  private async matchesPersistedReport(
    transaction: Transaction,
    run: {
      id: string;
      status: string;
      searchLimit: number;
      startedAt: Date | null;
      finishedAt: Date | null;
      searchedCount: number;
      fetchedCount: number;
      matchedCount: number;
      failedCount: number;
      discoveredCount: number;
      skuCount: number;
      incompleteCount: number;
      monitoredModelId: string;
      providerKey: string;
    },
    report: CollectorReport
  ): Promise<boolean> {
    if (
      run.status !== report.status
      || run.searchLimit !== report.searchLimit
      || run.startedAt?.toISOString() !== report.startedAt
      || run.finishedAt?.toISOString() !== report.completedAt
    ) {
      return false;
    }
    const counters = expectedCounters(report);
    if (Object.entries(counters).some(([key, value]) => Reflect.get(run, key) !== value)) return false;

    const positions = await transaction.collectionSearchPosition.findMany({
      where: { collectionRunId: report.runId },
      orderBy: { rank: "asc" }
    });
    if (positions.length !== report.positions.length) return false;
    for (const [index, expected] of report.positions.entries()) {
      const stored = positions[index];
      if (!stored || jsonValue({
        rank: stored.rank,
        platformItemId: stored.platformItemId,
        url: stored.url,
        shopName: stored.shopName,
        title: stored.title,
        displayPriceMinFen: stored.displayPriceMinFen,
        displayPriceMaxFen: stored.displayPriceMaxFen,
        sponsored: stored.sponsored,
        capturedAt: stored.capturedAt.toISOString()
      }) !== jsonValue(expected)) return false;
    }

    const candidateRows = await transaction.searchCandidate.findMany({
      where: {
        monitoredModelId: run.monitoredModelId,
        providerKey: run.providerKey,
        platformItemId: { in: report.competitorItems.map((item) => item.platformItemId) }
      },
      select: { id: true, platformItemId: true }
    });
    const candidates = new Map(candidateRows.map((candidate) => [candidate.platformItemId, candidate.id]));
    if (candidates.size !== report.competitorItems.length) return false;

    const expectedSnapshots = new Map<string, ReturnType<typeof snapshotValues>>();
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
        expectedSnapshots.set(ingestionKey, snapshotValues({
          runId: report.runId,
          item,
          sku,
          ownListingId: item.ownListingId,
          searchCandidateId: null,
          ingestionKey
        }));
      }
    }
    for (const item of report.competitorItems) {
      const candidateId = candidates.get(item.platformItemId);
      if (!candidateId) return false;
      for (const sku of item.skus) {
        const ingestionKey = snapshotIngestionKey(
          report.runId,
          "candidate",
          candidateId,
          item.platformItemId,
          sku.skuId,
          sku.capturedAt
        );
        expectedSnapshots.set(ingestionKey, snapshotValues({
          runId: report.runId,
          item,
          sku,
          ownListingId: null,
          searchCandidateId: candidateId,
          ingestionKey
        }));
      }
    }
    const snapshots = await transaction.offerSnapshot.findMany({ where: { collectionRunId: report.runId } });
    if (snapshots.length !== expectedSnapshots.size) return false;
    for (const snapshot of snapshots) {
      if (!snapshot.ingestionKey) return false;
      const expected = expectedSnapshots.get(snapshot.ingestionKey);
      if (!expected || !this.snapshotMatches(snapshot, expected)) return false;
    }

    const issues = await transaction.collectionIssue.findMany({ where: { collectionRunId: report.runId } });
    if (issues.length !== report.issues.length) return false;
    const storedIssues = new Map(issues.map((issue) => [issue.issueKey, issue]));
    for (const [index, expected] of report.issues.entries()) {
      const stored = storedIssues.get(issueIngestionKey(report.runId, expected, index));
      if (!stored || jsonValue({
        code: stored.code,
        platformItemId: stored.platformItemId,
        skuId: stored.skuId,
        message: stored.message,
        evidenceKey: stored.evidenceKey,
        capturedAt: stored.capturedAt.toISOString()
      }) !== jsonValue({
        code: expected.code,
        platformItemId: expected.platformItemId ?? null,
        skuId: expected.skuId ?? null,
        message: expected.message,
        evidenceKey: expected.evidenceKey ?? null,
        capturedAt: expected.capturedAt
      })) return false;
    }
    return true;
  }

  private snapshotMatches(
    stored: {
      collectionRunId: string;
      ownListingId: string | null;
      searchCandidateId: string | null;
      platformItemId: string;
      skuId: string | null;
      shopName: string;
      title: string;
      skuText: string | null;
      listPriceFen: number | null;
      activityPriceFen: number | null;
      couponDiscountFen: number;
      fullReductionFen: number;
      directDiscountFen: number;
      mandatoryFeeFen: number;
      publicDiscountFen: number;
      payableFen: number | null;
      priceConfidence: string;
      evidenceKey: string | null;
      ingestionKey: string | null;
      stockState: string;
      promotions: unknown;
      rawEvidence: unknown;
      capturedAt: Date;
    },
    expected: ReturnType<typeof snapshotValues>
  ): boolean {
    return jsonValue({
      collectionRunId: stored.collectionRunId,
      ownListingId: stored.ownListingId,
      searchCandidateId: stored.searchCandidateId,
      platformItemId: stored.platformItemId,
      skuId: stored.skuId,
      shopName: stored.shopName,
      title: stored.title,
      skuText: stored.skuText,
      listPriceFen: stored.listPriceFen,
      activityPriceFen: stored.activityPriceFen,
      couponDiscountFen: stored.couponDiscountFen,
      fullReductionFen: stored.fullReductionFen,
      directDiscountFen: stored.directDiscountFen,
      mandatoryFeeFen: stored.mandatoryFeeFen,
      publicDiscountFen: stored.publicDiscountFen,
      payableFen: stored.payableFen,
      priceConfidence: stored.priceConfidence,
      evidenceKey: stored.evidenceKey,
      ingestionKey: stored.ingestionKey,
      stockState: stored.stockState,
      promotions: stored.promotions,
      rawEvidence: stored.rawEvidence,
      capturedAt: stored.capturedAt.toISOString()
    }) === jsonValue({
      collectionRunId: expected.collectionRunId,
      ownListingId: expected.ownListingId,
      searchCandidateId: expected.searchCandidateId,
      platformItemId: expected.platformItemId,
      skuId: expected.skuId,
      shopName: expected.shopName,
      title: expected.title,
      skuText: expected.skuText,
      listPriceFen: expected.listPriceFen,
      activityPriceFen: expected.activityPriceFen,
      couponDiscountFen: expected.couponDiscountFen,
      fullReductionFen: expected.fullReductionFen,
      directDiscountFen: expected.directDiscountFen,
      mandatoryFeeFen: expected.mandatoryFeeFen,
      publicDiscountFen: expected.publicDiscountFen,
      payableFen: expected.payableFen,
      priceConfidence: expected.priceConfidence,
      evidenceKey: expected.evidenceKey,
      ingestionKey: expected.ingestionKey,
      stockState: expected.stockState,
      promotions: expected.promotions,
      rawEvidence: expected.rawEvidence,
      capturedAt: expected.capturedAt.toISOString()
    });
  }
}
