import { Prisma, type PrismaClient } from "../../../../generated/prisma/client.ts";

export const COLLECTION_REPORT_DEFAULT_PAGE_SIZE = 25;
export const COLLECTION_REPORT_DETAIL_DEFAULT_PAGE_SIZE = 50;
export const COLLECTION_REPORT_MAX_PAGE_SIZE = 100;
export const COLLECTION_REPORT_MAX_PAGE = 100_000;

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

export interface CollectionReportPaginationInput {
  page?: number;
  pageSize?: number;
}

export interface CollectionReportPageRequest {
  page: number;
  pageSize: number;
}

export interface CollectionReportPagedResult<T> {
  items: T[];
  total: number;
}

export interface CollectionRunDetailPaginationInput {
  positionPage?: number;
  positionPageSize?: number;
  issuePage?: number;
  issuePageSize?: number;
  skuPage?: number;
  skuPageSize?: number;
}

export interface CollectionReportPageMeta extends CollectionReportPageRequest {
  total: number;
  totalPages: number;
  hasPrevious: boolean;
  hasNext: boolean;
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
  incompleteCount: number;
  errorCode: string | null;
  errorMessage: string | null;
  positionCount: number;
  uniqueItemCount: number;
  snapshotCount: number;
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
}

export interface CollectionReportRawPosition {
  rank: number;
  platformItemId: string;
  url: string;
  shopName: string;
  title: string;
  displayPriceMinFen: number;
  displayPriceMaxFen: number;
  sponsored: boolean;
  capturedAt: Date;
}

export interface CollectionReportRawSnapshot {
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
}

export interface CollectionReportRawIssue {
  id: string;
  code: string;
  platformItemId: string | null;
  skuId: string | null;
  message: string;
  evidenceKey: string | null;
  capturedAt: Date;
}

export interface CollectionReportRawRank {
  platformItemId: string;
  ranks: number[];
}

export interface CollectionReportDataRepository {
  listRuns(request: CollectionReportPageRequest): Promise<CollectionReportPagedResult<CollectionReportRawRun>>;
  findRun(runId: string): Promise<CollectionReportRawRun | null>;
  listPositions(runId: string, request: CollectionReportPageRequest): Promise<CollectionReportPagedResult<CollectionReportRawPosition>>;
  listIssues(runId: string, request: CollectionReportPageRequest): Promise<CollectionReportPagedResult<CollectionReportRawIssue>>;
  findExactOwnBaseline(run: CollectionReportRawRun): Promise<CollectionReportRawSnapshot | null>;
  listSnapshots(
    run: CollectionReportRawRun,
    filters: CollectionRunReportFilters,
    baseline: CollectionReportRawSnapshot | null,
    request: CollectionReportPageRequest
  ): Promise<CollectionReportPagedResult<CollectionReportRawSnapshot>>;
  listRanks(runId: string, platformItemIds: string[]): Promise<CollectionReportRawRank[]>;
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
  positions: Array<Omit<CollectionReportRawPosition, "capturedAt"> & { capturedAt: string }>;
  issues: Array<Omit<CollectionReportRawIssue, "evidenceKey" | "capturedAt"> & {
    evidenceSha256: string | null;
    capturedAt: string;
  }>;
  filters: CollectionRunReportFilters;
  totalSkuCount: number;
  skus: CollectionRunSkuReportRow[];
  pagination: {
    positions: CollectionReportPageMeta;
    issues: CollectionReportPageMeta;
    skus: CollectionReportPageMeta;
  };
}

export interface CollectionRunReportList {
  runs: CollectionRunReportSummary[];
  pagination: CollectionReportPageMeta;
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

function boundedPositiveInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value ?? 0) < 1) return fallback;
  return Math.min(value!, maximum);
}

function normalizePageRequest(
  input: CollectionReportPaginationInput = {},
  defaultPageSize = COLLECTION_REPORT_DEFAULT_PAGE_SIZE
): CollectionReportPageRequest {
  return {
    page: boundedPositiveInteger(input.page, 1, COLLECTION_REPORT_MAX_PAGE),
    pageSize: boundedPositiveInteger(input.pageSize, defaultPageSize, COLLECTION_REPORT_MAX_PAGE_SIZE)
  };
}

function optionalPageInput(page: number | undefined, pageSize: number | undefined): CollectionReportPaginationInput {
  const input: CollectionReportPaginationInput = {};
  if (page !== undefined) input.page = page;
  if (pageSize !== undefined) input.pageSize = pageSize;
  return input;
}

function pageMeta(request: CollectionReportPageRequest, total: number): CollectionReportPageMeta {
  const normalizedTotal = Math.max(0, total);
  const totalPages = normalizedTotal === 0 ? 0 : Math.ceil(normalizedTotal / request.pageSize);
  return {
    ...request,
    total: normalizedTotal,
    totalPages,
    hasPrevious: request.page > 1 && totalPages > 0,
    hasNext: request.page < totalPages
  };
}

function modelLabel(run: CollectionReportRawRun): string {
  return `${run.monitoredModel.brand} ${run.monitoredModel.standardModel}`.trim();
}

function completion(run: CollectionReportRawRun): CollectionRunCompletion {
  const positionsCaptured = Math.max(0, run.positionCount);
  const requestedPositions = Math.max(0, run.searchLimit);
  const incompleteCount = Math.max(0, run.incompleteCount);
  const complete = positionsCaptured >= requestedPositions && incompleteCount === 0;
  return {
    positionsCaptured,
    requestedPositions,
    discoveredCount: Math.max(0, run.discoveredCount),
    fetchedCount: Math.max(0, run.fetchedCount),
    matchedCount: Math.max(0, run.matchedCount),
    failedCount: Math.max(0, run.failedCount),
    uniqueItemCount: Math.max(0, run.uniqueItemCount),
    skuCount: Math.max(0, run.snapshotCount),
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
  snapshot: CollectionReportRawSnapshot
): CollectionRunReportMatch {
  if (snapshot.matchDecision === "REJECTED") return "EXCLUDED";
  if (snapshot.comparable && snapshot.matchDecision === run.monitoredModel.comparisonType) return "EXACT";
  return "REVIEW";
}

function comparisonFor(
  run: CollectionReportRawRun,
  snapshot: CollectionReportRawSnapshot,
  baseline: CollectionReportRawSnapshot | null
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
  snapshot: CollectionReportRawSnapshot,
  ranks: ReadonlyMap<string, number[]>,
  baseline: CollectionReportRawSnapshot | null
): CollectionRunSkuReportRow {
  return {
    id: snapshot.id,
    source: snapshot.ownListingId ? "OWN" : "COMPETITOR",
    platformItemId: snapshot.platformItemId,
    skuId: snapshot.skuId,
    shopName: snapshot.shopName,
    title: snapshot.title,
    skuText: snapshot.skuText,
    url: snapshot.url,
    ranks: [...(ranks.get(snapshot.platformItemId) ?? [])].sort((left, right) => left - right),
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

const reportRunSummarySelect = {
  id: true,
  status: true,
  providerKey: true,
  scheduledFor: true,
  startedAt: true,
  finishedAt: true,
  searchLimit: true,
  searchedCount: true,
  fetchedCount: true,
  matchedCount: true,
  failedCount: true,
  discoveredCount: true,
  incompleteCount: true,
  errorCode: true,
  errorMessage: true,
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
  _count: { select: { positions: true, snapshots: true } }
} satisfies Prisma.CollectionRunSelect;

const snapshotSelect = {
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
} satisfies Prisma.OfferSnapshotSelect;

type PrismaReportRun = Prisma.CollectionRunGetPayload<{ select: typeof reportRunSummarySelect }>;
type PrismaReportSnapshot = Prisma.OfferSnapshotGetPayload<{ select: typeof snapshotSelect }>;

function toRawRun(run: PrismaReportRun, uniqueItemCount: number): CollectionReportRawRun {
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
    incompleteCount: run.incompleteCount,
    errorCode: run.errorCode,
    errorMessage: run.errorMessage,
    positionCount: run._count.positions,
    uniqueItemCount,
    snapshotCount: run._count.snapshots,
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
    } : null
  };
}

function toRawSnapshot(snapshot: PrismaReportSnapshot): CollectionReportRawSnapshot {
  return {
    ...snapshot,
    ownListingSkuText: snapshot.ownListing?.skuText ?? null,
    url: snapshot.ownListing?.url ?? snapshot.searchCandidate?.url ?? "",
    priceConfidence: snapshot.priceConfidence,
    stockState: snapshot.stockState,
    matchDecision: snapshot.matchDecision,
    matchReasons: asStringList(snapshot.matchReasons)
  };
}

function pageOffset(request: CollectionReportPageRequest): number {
  return (request.page - 1) * request.pageSize;
}

function snapshotFilterSql(
  run: CollectionReportRawRun,
  filters: CollectionRunReportFilters,
  baseline: CollectionReportRawSnapshot | null
): Prisma.Sql | null {
  const clauses: Prisma.Sql[] = [Prisma.sql`s."collectionRunId" = ${run.id}`];
  if (filters.source === "OWN") clauses.push(Prisma.sql`s."ownListingId" IS NOT NULL`);
  if (filters.source === "COMPETITOR") clauses.push(Prisma.sql`s."ownListingId" IS NULL`);
  if (filters.confidence) clauses.push(Prisma.sql`s."priceConfidence"::text = ${filters.confidence}`);

  if (filters.match === "EXACT") {
    clauses.push(Prisma.sql`s."comparable" = TRUE`);
    clauses.push(Prisma.sql`s."matchDecision"::text = ${run.monitoredModel.comparisonType}`);
  } else if (filters.match === "EXCLUDED") {
    clauses.push(Prisma.sql`s."matchDecision"::text = 'REJECTED'`);
  } else if (filters.match === "REVIEW") {
    clauses.push(Prisma.sql`s."matchDecision"::text IS DISTINCT FROM 'REJECTED'`);
    clauses.push(Prisma.sql`NOT (s."comparable" = TRUE AND s."matchDecision"::text = ${run.monitoredModel.comparisonType})`);
  }

  if (filters.price) {
    if (baseline === null || baseline.payableFen === null) return null;
    clauses.push(Prisma.sql`s."ownListingId" IS NULL`);
    clauses.push(Prisma.sql`s."comparable" = TRUE`);
    clauses.push(Prisma.sql`s."matchDecision"::text = ${run.monitoredModel.comparisonType}`);
    clauses.push(Prisma.sql`s."stockState"::text = 'IN_STOCK'`);
    clauses.push(Prisma.sql`s."priceConfidence"::text = 'CONFIRMED'`);
    clauses.push(Prisma.sql`s."payableFen" IS NOT NULL`);
    clauses.push(filters.price === "LOWER"
      ? Prisma.sql`s."payableFen" < ${baseline.payableFen}`
      : Prisma.sql`s."payableFen" >= ${baseline.payableFen}`);
  }

  return Prisma.join(clauses, " AND ");
}

export class PrismaCollectionReportRepository implements CollectionReportDataRepository {
  private readonly prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  private async uniqueItemCounts(runIds: string[]): Promise<Map<string, number>> {
    if (runIds.length === 0) return new Map();
    const rows = await this.prisma.$queryRaw<Array<{ collectionRunId: string; uniqueItemCount: bigint | number }>>(
      Prisma.sql`
        SELECT "collectionRunId", COUNT(DISTINCT "platformItemId")::int AS "uniqueItemCount"
        FROM "CollectionSearchPosition"
        WHERE "collectionRunId" IN (${Prisma.join(runIds)})
        GROUP BY "collectionRunId"
      `
    );
    return new Map(rows.map((row) => [row.collectionRunId, Number(row.uniqueItemCount)]));
  }

  async listRuns(input: CollectionReportPageRequest): Promise<CollectionReportPagedResult<CollectionReportRawRun>> {
    const request = normalizePageRequest(input);
    const [runs, total] = await Promise.all([
      this.prisma.collectionRun.findMany({
        select: reportRunSummarySelect,
        orderBy: [{ scheduledFor: "desc" }, { createdAt: "desc" }, { id: "desc" }],
        skip: pageOffset(request),
        take: request.pageSize
      }),
      this.prisma.collectionRun.count()
    ]);
    const uniqueCounts = await this.uniqueItemCounts(runs.map((run) => run.id));
    return {
      items: runs.map((run) => toRawRun(run, uniqueCounts.get(run.id) ?? 0)),
      total
    };
  }

  async findRun(runId: string): Promise<CollectionReportRawRun | null> {
    const run = await this.prisma.collectionRun.findUnique({ where: { id: runId }, select: reportRunSummarySelect });
    if (!run) return null;
    const uniqueCounts = await this.uniqueItemCounts([runId]);
    return toRawRun(run, uniqueCounts.get(runId) ?? 0);
  }

  async listPositions(runId: string, input: CollectionReportPageRequest) {
    const request = normalizePageRequest(input, COLLECTION_REPORT_DETAIL_DEFAULT_PAGE_SIZE);
    const where = { collectionRunId: runId };
    const [items, total] = await Promise.all([
      this.prisma.collectionSearchPosition.findMany({
        where,
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
        orderBy: { rank: "asc" },
        skip: pageOffset(request),
        take: request.pageSize
      }),
      this.prisma.collectionSearchPosition.count({ where })
    ]);
    return { items, total };
  }

  async listIssues(runId: string, input: CollectionReportPageRequest) {
    const request = normalizePageRequest(input, COLLECTION_REPORT_DETAIL_DEFAULT_PAGE_SIZE);
    const where = { collectionRunId: runId };
    const [items, total] = await Promise.all([
      this.prisma.collectionIssue.findMany({
        where,
        select: {
          id: true,
          code: true,
          platformItemId: true,
          skuId: true,
          message: true,
          evidenceKey: true,
          capturedAt: true
        },
        orderBy: [{ capturedAt: "asc" }, { id: "asc" }],
        skip: pageOffset(request),
        take: request.pageSize
      }),
      this.prisma.collectionIssue.count({ where })
    ]);
    return { items, total };
  }

  async findExactOwnBaseline(run: CollectionReportRawRun): Promise<CollectionReportRawSnapshot | null> {
    const ids = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT s."id"
      FROM "OfferSnapshot" s
      INNER JOIN "OwnListing" own ON own."id" = s."ownListingId"
      WHERE s."collectionRunId" = ${run.id}
        AND s."skuText" IS NOT NULL
        AND LOWER(BTRIM(s."skuText")) = LOWER(BTRIM(own."skuText"))
        AND s."comparable" = TRUE
        AND s."matchDecision"::text = ${run.monitoredModel.comparisonType}
        AND s."stockState"::text = 'IN_STOCK'
        AND s."priceConfidence"::text = 'CONFIRMED'
        AND s."payableFen" IS NOT NULL
      ORDER BY s."id" ASC
      LIMIT 2
    `);
    if (ids.length !== 1) return null;
    const snapshot = await this.prisma.offerSnapshot.findUnique({ where: { id: ids[0]!.id }, select: snapshotSelect });
    return snapshot ? toRawSnapshot(snapshot) : null;
  }

  async listSnapshots(
    run: CollectionReportRawRun,
    filters: CollectionRunReportFilters,
    baseline: CollectionReportRawSnapshot | null,
    input: CollectionReportPageRequest
  ): Promise<CollectionReportPagedResult<CollectionReportRawSnapshot>> {
    const request = normalizePageRequest(input, COLLECTION_REPORT_DETAIL_DEFAULT_PAGE_SIZE);
    const whereSql = snapshotFilterSql(run, filters, baseline);
    if (!whereSql) return { items: [], total: 0 };
    const [idRows, countRows] = await Promise.all([
      this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT s."id"
        FROM "OfferSnapshot" s
        LEFT JOIN "CollectionSearchPosition" position
          ON position."collectionRunId" = s."collectionRunId"
          AND position."platformItemId" = s."platformItemId"
        WHERE ${whereSql}
        GROUP BY s."id"
        ORDER BY MIN(position."rank") ASC NULLS LAST,
          CASE WHEN s."ownListingId" IS NOT NULL THEN 0 ELSE 1 END,
          s."platformItemId" ASC,
          COALESCE(s."skuId", '') ASC,
          s."id" ASC
        LIMIT ${request.pageSize}
        OFFSET ${pageOffset(request)}
      `),
      this.prisma.$queryRaw<Array<{ total: bigint | number }>>(Prisma.sql`
        SELECT COUNT(*)::int AS "total"
        FROM "OfferSnapshot" s
        WHERE ${whereSql}
      `)
    ]);
    const ids = idRows.map((row) => row.id);
    if (ids.length === 0) return { items: [], total: Number(countRows[0]?.total ?? 0) };
    const snapshots = await this.prisma.offerSnapshot.findMany({ where: { id: { in: ids } }, select: snapshotSelect });
    const byId = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]));
    return {
      items: ids.flatMap((id) => {
        const snapshot = byId.get(id);
        return snapshot ? [toRawSnapshot(snapshot)] : [];
      }),
      total: Number(countRows[0]?.total ?? 0)
    };
  }

  async listRanks(runId: string, platformItemIds: string[]): Promise<CollectionReportRawRank[]> {
    const ids = [...new Set(platformItemIds)].slice(0, COLLECTION_REPORT_MAX_PAGE_SIZE);
    if (ids.length === 0) return [];
    return this.prisma.$queryRaw<CollectionReportRawRank[]>(Prisma.sql`
      SELECT "platformItemId", ARRAY_AGG("rank" ORDER BY "rank") AS "ranks"
      FROM "CollectionSearchPosition"
      WHERE "collectionRunId" = ${runId}
        AND "platformItemId" IN (${Prisma.join(ids)})
      GROUP BY "platformItemId"
      ORDER BY MIN("rank") ASC
      LIMIT ${ids.length}
    `);
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

  async listRuns(input: CollectionReportPaginationInput = {}): Promise<CollectionRunReportList> {
    const request = normalizePageRequest(input);
    const result = await this.repository.listRuns(request);
    return { runs: result.items.map(summary), pagination: pageMeta(request, result.total) };
  }

  async getRun(
    runId: string,
    filters: CollectionRunReportFilters = {},
    pagination: CollectionRunDetailPaginationInput = {}
  ): Promise<CollectionRunReportDetail | null> {
    const run = await this.repository.findRun(runId);
    if (!run) return null;
    const positionRequest = normalizePageRequest(
      optionalPageInput(pagination.positionPage, pagination.positionPageSize),
      COLLECTION_REPORT_DETAIL_DEFAULT_PAGE_SIZE
    );
    const issueRequest = normalizePageRequest(
      optionalPageInput(pagination.issuePage, pagination.issuePageSize),
      COLLECTION_REPORT_DETAIL_DEFAULT_PAGE_SIZE
    );
    const skuRequest = normalizePageRequest(
      optionalPageInput(pagination.skuPage, pagination.skuPageSize),
      COLLECTION_REPORT_DETAIL_DEFAULT_PAGE_SIZE
    );

    const baselinePromise = this.repository.findExactOwnBaseline(run);
    const positionsPromise = this.repository.listPositions(runId, positionRequest);
    const issuesPromise = this.repository.listIssues(runId, issueRequest);
    const baseline = await baselinePromise;
    const snapshotsPromise = this.repository.listSnapshots(run, filters, baseline, skuRequest);
    const [positions, issues, snapshots] = await Promise.all([positionsPromise, issuesPromise, snapshotsPromise]);
    const rankRows = await this.repository.listRanks(runId, snapshots.items.map((snapshot) => snapshot.platformItemId));
    const ranks = new Map<string, number[]>();
    for (const row of rankRows) {
      ranks.set(row.platformItemId, row.ranks);
    }

    return {
      ...summary(run),
      positions: positions.items.map((position) => ({
        ...position,
        capturedAt: position.capturedAt.toISOString()
      })),
      issues: issues.items.map(({ evidenceKey, ...issue }) => ({
        ...issue,
        evidenceSha256: digestFromEvidenceKey(evidenceKey),
        capturedAt: issue.capturedAt.toISOString()
      })),
      filters,
      totalSkuCount: run.snapshotCount,
      skus: snapshots.items.map((snapshot) => toSkuRow(run, snapshot, ranks, baseline)),
      pagination: {
        positions: pageMeta(positionRequest, positions.total),
        issues: pageMeta(issueRequest, issues.total),
        skus: pageMeta(skuRequest, snapshots.total)
      }
    };
  }

  async isEvidenceReferenced(runId: string, sha256: string): Promise<boolean> {
    if (!evidenceDigestPattern.test(sha256)) return false;
    return this.repository.isEvidenceReferenced(runId, `sha256:${sha256}`);
  }
}
