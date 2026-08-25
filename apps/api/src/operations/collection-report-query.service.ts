import { Prisma, type PrismaClient } from "../../../../generated/prisma/client.ts";

export type CollectionRunReportSource = "OWN" | "COMPETITOR";
export type CollectionRunReportMatch = "EXACT" | "REVIEW" | "EXCLUDED";
export type CollectionRunReportPrice = "LOWER" | "NOT_LOWER";
export type CollectionRunReportConfidence = "CONFIRMED" | "ESTIMATED" | "MANUAL_REVIEW";

export interface CollectionRunReportFilters {
  source?: CollectionRunReportSource;
  match?: CollectionRunReportMatch;
  price?: CollectionRunReportPrice;
  confidence?: CollectionRunReportConfidence;
}

export interface CollectionReportRawRun {
  id: string;
  status: string;
  providerKey: string;
  scheduledFor: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  searchLimit: number;
  searchedCount: number;
  fetchedCount: number;
  matchedCount: number;
  failedCount: number;
  discoveredCount: number;
  skuCount: number;
  incompleteCount: number;
  errorCode: string | null;
  errorMessage: string | null;
  monitoredModel: {
    id: string;
    monitorCode: string;
    brand: string;
    standardModel: string;
    comparisonType: "BARE" | "BUNDLE";
    owner: string;
  };
  collectorAgent: {
    id: string;
    name: string;
    platform: "MACOS" | "WINDOWS";
    appVersion: string | null;
  } | null;
  alertNotificationBatch: {
    state: "PENDING" | "SENDING" | "NOTIFIED" | "FAILED";
    notificationAttempts: number;
    notifiedAt: Date | null;
    lastNotificationError: string | null;
  } | null;
  positions: Array<{
    rank: number;
    platformItemId: string;
    url: string;
    shopName: string;
    title: string;
    displayPriceMinFen: number;
    displayPriceMaxFen: number;
    sponsored: boolean;
    capturedAt: Date;
  }>;
  snapshots: Array<{
    id: string;
    ownListingId: string | null;
    searchCandidateId: string | null;
    platformItemId: string;
    skuId: string | null;
    shopName: string;
    title: string;
    skuText: string | null;
    ownListingSkuText: string | null;
    url: string;
    listPriceFen: number | null;
    activityPriceFen: number | null;
    couponDiscountFen: number;
    fullReductionFen: number;
    directDiscountFen: number;
    mandatoryFeeFen: number;
    publicDiscountFen: number;
    payableFen: number | null;
    priceConfidence: CollectionRunReportConfidence;
    stockState: "IN_STOCK" | "OUT_OF_STOCK" | "UNKNOWN";
    matchDecision: "PENDING" | "BARE" | "BUNDLE" | "REJECTED" | "MANUAL" | null;
    comparable: boolean;
    matchConfidenceBps: number;
    matchReasons: string[];
    evidenceKey: string | null;
    capturedAt: Date;
  }>;
  issues: Array<{
    id: string;
    code: string;
    platformItemId: string | null;
    skuId: string | null;
    message: string;
    evidenceKey: string | null;
    capturedAt: Date;
  }>;
}

export interface CollectionReportDataRepository {
  listRuns(): Promise<CollectionReportRawRun[]>;
  findRun(runId: string): Promise<CollectionReportRawRun | null>;
  isEvidenceReferenced(runId: string, evidenceKey: string): Promise<boolean>;
}

export interface CollectionRunCompletion {
  positionsCaptured: number;
  requestedPositions: number;
  discoveredCount: number;
  fetchedCount: number;
  matchedCount: number;
  failedCount: number;
  uniqueItemCount: number;
  skuCount: number;
  incompleteCount: number;
  complete: boolean;
  label: string;
}

export interface CollectionRunReportSummary {
  id: string;
  status: string;
  provider: string;
  scheduledFor: string;
  startedAt: string | null;
  finishedAt: string | null;
  model: {
    id: string;
    monitorCode: string;
    label: string;
    comparisonType: "BARE" | "BUNDLE";
    owner: string;
  };
  collector: {
    id: string;
    name: string;
    platform: "MACOS" | "WINDOWS";
    appVersion: string | null;
  } | null;
  completion: CollectionRunCompletion;
  notification: {
    state: "NOT_CREATED" | "PENDING" | "SENDING" | "NOTIFIED" | "FAILED";
    attempts: number;
    notifiedAt: string | null;
    lastError: string | null;
  };
  error: { code: string; message: string | null } | null;
}

export interface CollectionRunSkuReportRow {
  id: string;
  source: CollectionRunReportSource;
  platformItemId: string;
  skuId: string | null;
  shopName: string;
  title: string;
  skuText: string | null;
  url: string;
  ranks: number[];
  prices: {
    listPriceFen: number | null;
    activityPriceFen: number | null;
    couponDiscountFen: number;
    fullReductionFen: number;
    directDiscountFen: number;
    mandatoryFeeFen: number;
    publicDiscountFen: number;
    payableFen: number | null;
  };
  stockState: "IN_STOCK" | "OUT_OF_STOCK" | "UNKNOWN";
  confidence: CollectionRunReportConfidence;
  match: {
    category: CollectionRunReportMatch;
    decision: "PENDING" | "BARE" | "BUNDLE" | "REJECTED" | "MANUAL" | null;
    comparable: boolean;
    confidenceBps: number;
    reasons: string[];
  };
  comparison: {
    state: "OWN" | "LOWER" | "NOT_LOWER" | "UNDECIDED";
    ownPayableFen: number | null;
    differenceFen: number | null;
  };
  evidenceSha256: string | null;
  capturedAt: string;
}

export interface CollectionRunReportDetail extends CollectionRunReportSummary {
  positions: Array<{
    rank: number;
    platformItemId: string;
    url: string;
    shopName: string;
    title: string;
    displayPriceMinFen: number;
    displayPriceMaxFen: number;
    sponsored: boolean;
    capturedAt: string;
  }>;
  issues: Array<{
    id: string;
    code: string;
    platformItemId: string | null;
    skuId: string | null;
    message: string;
    evidenceSha256: string | null;
    capturedAt: string;
  }>;
  filters: CollectionRunReportFilters;
  totalSkuCount: number;
  skus: CollectionRunSkuReportRow[];
}

const evidenceKeyPattern = /^sha256:([0-9a-f]{64})$/;
const evidenceDigestPattern = /^[0-9a-f]{64}$/;

function asStringList(value: Prisma.JsonValue | null): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function digestFromEvidenceKey(value: string | null): string | null {
  return evidenceKeyPattern.exec(value ?? "")?.[1] ?? null;
}

function modelLabel(run: CollectionReportRawRun): string {
  return `${run.monitoredModel.brand} ${run.monitoredModel.standardModel}`.trim();
}

function completion(run: CollectionReportRawRun): CollectionRunCompletion {
  const positionsCaptured = run.positions.length;
  const requestedPositions = Math.max(0, run.searchLimit);
  const uniqueItemCount = new Set(run.positions.map((position) => position.platformItemId)).size;
  const incompleteCount = Math.max(0, run.incompleteCount);
  const complete = positionsCaptured >= requestedPositions && incompleteCount === 0;
  return {
    positionsCaptured,
    requestedPositions,
    discoveredCount: Math.max(0, run.discoveredCount),
    fetchedCount: Math.max(0, run.fetchedCount),
    matchedCount: Math.max(0, run.matchedCount),
    failedCount: Math.max(0, run.failedCount),
    uniqueItemCount,
    skuCount: Math.max(0, run.skuCount || run.snapshots.length),
    incompleteCount,
    complete,
    label: complete
      ? `${positionsCaptured} / ${requestedPositions}，已完成`
      : `${positionsCaptured} / ${requestedPositions}，未完成`
  };
}

function summary(run: CollectionReportRawRun): CollectionRunReportSummary {
  return {
    id: run.id,
    status: run.status,
    provider: run.providerKey,
    scheduledFor: run.scheduledFor.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
    model: {
      id: run.monitoredModel.id,
      monitorCode: run.monitoredModel.monitorCode,
      label: modelLabel(run),
      comparisonType: run.monitoredModel.comparisonType,
      owner: run.monitoredModel.owner
    },
    collector: run.collectorAgent ? {
      id: run.collectorAgent.id,
      name: run.collectorAgent.name,
      platform: run.collectorAgent.platform,
      appVersion: run.collectorAgent.appVersion
    } : null,
    completion: completion(run),
    notification: run.alertNotificationBatch ? {
      state: run.alertNotificationBatch.state,
      attempts: run.alertNotificationBatch.notificationAttempts,
      notifiedAt: run.alertNotificationBatch.notifiedAt?.toISOString() ?? null,
      lastError: run.alertNotificationBatch.lastNotificationError
    } : {
      state: "NOT_CREATED",
      attempts: 0,
      notifiedAt: null,
      lastError: null
    },
    error: run.errorCode ? { code: run.errorCode, message: run.errorMessage } : null
  };
}

function matchCategory(
  run: CollectionReportRawRun,
  snapshot: CollectionReportRawRun["snapshots"][number]
): CollectionRunReportMatch {
  if (snapshot.matchDecision === "REJECTED") return "EXCLUDED";
  if (snapshot.comparable && snapshot.matchDecision === run.monitoredModel.comparisonType) return "EXACT";
  return "REVIEW";
}

function exactOwnBaseline(run: CollectionReportRawRun) {
  const candidates = run.snapshots.filter((snapshot) => {
    if (!snapshot.ownListingId || !snapshot.ownListingSkuText || !snapshot.skuText) return false;
    return snapshot.skuText.trim().toLocaleLowerCase() === snapshot.ownListingSkuText.trim().toLocaleLowerCase()
      && matchCategory(run, snapshot) === "EXACT"
      && snapshot.stockState === "IN_STOCK"
      && snapshot.priceConfidence === "CONFIRMED"
      && snapshot.payableFen !== null;
  });
  return candidates.length === 1 ? candidates[0]! : null;
}

function rankFor(snapshot: CollectionReportRawRun["snapshots"][number], ranks: ReadonlyMap<string, number[]>): number[] {
  return [...(ranks.get(snapshot.platformItemId) ?? [])].sort((left, right) => left - right);
}

function comparisonFor(
  run: CollectionReportRawRun,
  snapshot: CollectionReportRawRun["snapshots"][number],
  baseline: CollectionReportRawRun["snapshots"][number] | null
): CollectionRunSkuReportRow["comparison"] {
  if (snapshot.ownListingId) {
    return { state: "OWN", ownPayableFen: baseline?.payableFen ?? null, differenceFen: null };
  }
  if (
    !baseline
    || matchCategory(run, snapshot) !== "EXACT"
    || snapshot.stockState !== "IN_STOCK"
    || snapshot.priceConfidence !== "CONFIRMED"
    || snapshot.payableFen === null
  ) {
    return { state: "UNDECIDED", ownPayableFen: baseline?.payableFen ?? null, differenceFen: null };
  }
  const differenceFen = baseline.payableFen! - snapshot.payableFen;
  return {
    state: differenceFen > 0 ? "LOWER" : "NOT_LOWER",
    ownPayableFen: baseline.payableFen,
    differenceFen: Math.abs(differenceFen)
  };
}

function toSkuRow(
  run: CollectionReportRawRun,
  snapshot: CollectionReportRawRun["snapshots"][number],
  ranks: ReadonlyMap<string, number[]>,
  baseline: CollectionReportRawRun["snapshots"][number] | null
): CollectionRunSkuReportRow {
  const source: CollectionRunReportSource = snapshot.ownListingId ? "OWN" : "COMPETITOR";
  return {
    id: snapshot.id,
    source,
    platformItemId: snapshot.platformItemId,
    skuId: snapshot.skuId,
    shopName: snapshot.shopName,
    title: snapshot.title,
    skuText: snapshot.skuText,
    url: snapshot.url,
    ranks: rankFor(snapshot, ranks),
    prices: {
      listPriceFen: snapshot.listPriceFen,
      activityPriceFen: snapshot.activityPriceFen,
      couponDiscountFen: snapshot.couponDiscountFen,
      fullReductionFen: snapshot.fullReductionFen,
      directDiscountFen: snapshot.directDiscountFen,
      mandatoryFeeFen: snapshot.mandatoryFeeFen,
      publicDiscountFen: snapshot.publicDiscountFen,
      payableFen: snapshot.payableFen
    },
    stockState: snapshot.stockState,
    confidence: snapshot.priceConfidence,
    match: {
      category: matchCategory(run, snapshot),
      decision: snapshot.matchDecision,
      comparable: snapshot.comparable,
      confidenceBps: snapshot.matchConfidenceBps,
      reasons: snapshot.matchReasons
    },
    comparison: comparisonFor(run, snapshot, baseline),
    evidenceSha256: digestFromEvidenceKey(snapshot.evidenceKey),
    capturedAt: snapshot.capturedAt.toISOString()
  };
}

function matchesFilters(row: CollectionRunSkuReportRow, filters: CollectionRunReportFilters): boolean {
  return (!filters.source || row.source === filters.source)
    && (!filters.match || row.match.category === filters.match)
    && (!filters.price || row.comparison.state === filters.price)
    && (!filters.confidence || row.confidence === filters.confidence);
}

function sortSkuRows(left: CollectionRunSkuReportRow, right: CollectionRunSkuReportRow): number {
  const leftRank = left.ranks[0] ?? Number.MAX_SAFE_INTEGER;
  const rightRank = right.ranks[0] ?? Number.MAX_SAFE_INTEGER;
  return leftRank - rightRank
    || (left.source === "OWN" ? -1 : 1) - (right.source === "OWN" ? -1 : 1)
    || left.platformItemId.localeCompare(right.platformItemId)
    || (left.skuId ?? "").localeCompare(right.skuId ?? "")
    || left.id.localeCompare(right.id);
}

const reportRunInclude = {
  monitoredModel: {
    select: {
      id: true,
      monitorCode: true,
      brand: true,
      standardModel: true,
      comparisonType: true,
      owner: true
    }
  },
  collectorAgent: { select: { id: true, name: true, platform: true, appVersion: true } },
  alertNotificationBatch: {
    select: { state: true, notificationAttempts: true, notifiedAt: true, lastNotificationError: true }
  },
  positions: {
    select: {
      rank: true,
      platformItemId: true,
      url: true,
      shopName: true,
      title: true,
      displayPriceMinFen: true,
      displayPriceMaxFen: true,
      sponsored: true,
      capturedAt: true
    },
    orderBy: { rank: "asc" }
  },
  snapshots: {
    select: {
      id: true,
      ownListingId: true,
      searchCandidateId: true,
      platformItemId: true,
      skuId: true,
      shopName: true,
      title: true,
      skuText: true,
      listPriceFen: true,
      activityPriceFen: true,
      couponDiscountFen: true,
      fullReductionFen: true,
      directDiscountFen: true,
      mandatoryFeeFen: true,
      publicDiscountFen: true,
      payableFen: true,
      priceConfidence: true,
      stockState: true,
      matchDecision: true,
      comparable: true,
      matchConfidenceBps: true,
      matchReasons: true,
      evidenceKey: true,
      capturedAt: true,
      ownListing: { select: { skuText: true, url: true } },
      searchCandidate: { select: { url: true } }
    }
  },
  issues: {
    select: {
      id: true,
      code: true,
      platformItemId: true,
      skuId: true,
      message: true,
      evidenceKey: true,
      capturedAt: true
    },
    orderBy: { capturedAt: "asc" }
  }
} satisfies Prisma.CollectionRunInclude;

type PrismaReportRun = Prisma.CollectionRunGetPayload<{ include: typeof reportRunInclude }>;

function toRawRun(run: PrismaReportRun): CollectionReportRawRun {
  return {
    id: run.id,
    status: run.status,
    providerKey: run.providerKey,
    scheduledFor: run.scheduledFor,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    searchLimit: run.searchLimit,
    searchedCount: run.searchedCount,
    fetchedCount: run.fetchedCount,
    matchedCount: run.matchedCount,
    failedCount: run.failedCount,
    discoveredCount: run.discoveredCount,
    skuCount: run.skuCount,
    incompleteCount: run.incompleteCount,
    errorCode: run.errorCode,
    errorMessage: run.errorMessage,
    monitoredModel: {
      ...run.monitoredModel,
      comparisonType: run.monitoredModel.comparisonType,
      owner: run.monitoredModel.owner
    },
    collectorAgent: run.collectorAgent ? {
      ...run.collectorAgent,
      platform: run.collectorAgent.platform
    } : null,
    alertNotificationBatch: run.alertNotificationBatch ? {
      ...run.alertNotificationBatch,
      state: run.alertNotificationBatch.state
    } : null,
    positions: run.positions,
    snapshots: run.snapshots.map((snapshot) => ({
      ...snapshot,
      ownListingSkuText: snapshot.ownListing?.skuText ?? null,
      url: snapshot.ownListing?.url ?? snapshot.searchCandidate?.url ?? "",
      priceConfidence: snapshot.priceConfidence,
      stockState: snapshot.stockState,
      matchDecision: snapshot.matchDecision,
      matchReasons: asStringList(snapshot.matchReasons)
    })),
    issues: run.issues
  };
}

export class PrismaCollectionReportRepository implements CollectionReportDataRepository {
  private readonly prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  async listRuns(): Promise<CollectionReportRawRun[]> {
    const runs = await this.prisma.collectionRun.findMany({
      include: reportRunInclude,
      orderBy: [{ scheduledFor: "desc" }, { createdAt: "desc" }, { id: "desc" }],
      take: 200
    });
    return runs.map(toRawRun);
  }

  async findRun(runId: string): Promise<CollectionReportRawRun | null> {
    const run = await this.prisma.collectionRun.findUnique({ where: { id: runId }, include: reportRunInclude });
    return run ? toRawRun(run) : null;
  }

  async isEvidenceReferenced(runId: string, evidenceKey: string): Promise<boolean> {
    const [snapshot, issue] = await Promise.all([
      this.prisma.offerSnapshot.findFirst({
        where: { collectionRunId: runId, evidenceKey },
        select: { id: true }
      }),
      this.prisma.collectionIssue.findFirst({
        where: { collectionRunId: runId, evidenceKey },
        select: { id: true }
      })
    ]);
    return Boolean(snapshot || issue);
  }
}

export class CollectionReportQueryService {
  private readonly repository: CollectionReportDataRepository;

  constructor(repository: CollectionReportDataRepository) {
    this.repository = repository;
  }

  async listRuns(): Promise<{ runs: CollectionRunReportSummary[] }> {
    const runs = await this.repository.listRuns();
    return { runs: runs.map(summary) };
  }

  async getRun(
    runId: string,
    filters: CollectionRunReportFilters = {}
  ): Promise<CollectionRunReportDetail | null> {
    const run = await this.repository.findRun(runId);
    if (!run) return null;
    const ranks = new Map<string, number[]>();
    for (const position of run.positions) {
      const current = ranks.get(position.platformItemId) ?? [];
      current.push(position.rank);
      ranks.set(position.platformItemId, current);
    }
    const baseline = exactOwnBaseline(run);
    const allSkus = run.snapshots.map((snapshot) => toSkuRow(run, snapshot, ranks, baseline)).sort(sortSkuRows);
    return {
      ...summary(run),
      positions: run.positions.map((position) => ({
        ...position,
        capturedAt: position.capturedAt.toISOString()
      })),
      issues: run.issues.map((issue) => ({
        ...issue,
        evidenceSha256: digestFromEvidenceKey(issue.evidenceKey),
        capturedAt: issue.capturedAt.toISOString()
      })),
      filters,
      totalSkuCount: allSkus.length,
      skus: allSkus.filter((row) => matchesFilters(row, filters))
    };
  }

  async isEvidenceReferenced(runId: string, sha256: string): Promise<boolean> {
    if (!evidenceDigestPattern.test(sha256)) return false;
    return this.repository.isEvidenceReferenced(runId, `sha256:${sha256}`);
  }
}
