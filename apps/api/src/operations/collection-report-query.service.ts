import { Prisma, type PrismaClient } from "../../../../generated/prisma/client.ts";
import {
  deriveOwnCatalogCompleteness,
  type OwnCatalogCompleteness
} from "../collection/own-catalog-completeness.ts";
import {
  aggregateCollectionRunReport,
  projectCollectionRunBusinessSkuRows,
  type CollectionRunBusinessAggregationInput,
  type CollectionRunBusinessPositionFact,
  type CollectionRunBusinessSections,
  type CollectionRunBusinessSkuRow,
  type CollectionRunBusinessSnapshotFact,
  type CollectionRunCombinationState
} from "./collection-report-aggregation.ts";

export const COLLECTION_REPORT_DEFAULT_PAGE_SIZE = 25;
export const COLLECTION_REPORT_DETAIL_DEFAULT_PAGE_SIZE = 50;
export const COLLECTION_REPORT_MAX_PAGE_SIZE = 100;
export const COLLECTION_REPORT_MAX_PAGE = 100_000;

export type CollectionRunReportSource = "OWN" | "COMPETITOR";
export type CollectionRunReportMatch = "EXACT" | "REVIEW" | "EXCLUDED";
export type CollectionRunReportPrice = "LOWER" | "NOT_LOWER";
export type CollectionRunReportConfidence = "CONFIRMED" | "ESTIMATED" | "MANUAL_REVIEW";
export type CollectionRunReportCombinationState = CollectionRunCombinationState;

export interface CollectionRunReportFilters {
  source?: CollectionRunReportSource;
  match?: CollectionRunReportMatch;
  price?: CollectionRunReportPrice;
  confidence?: CollectionRunReportConfidence;
  combinationState?: CollectionRunReportCombinationState;
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
  searchTerminationReason: "LIMIT_REACHED" | "END_MARKER" | null;
  ownBaselineSnapshotId: string | null;
  claimedOwnListingIds: string[];
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
    sessionState: "READY" | "LOGIN_REQUIRED" | "CHALLENGE_REQUIRED" | "UNAVAILABLE";
    sessionObservedAt: Date | null;
    sessionChangedAt: Date | null;
  } | null;
  alertNotificationBatch: {
    state: "PENDING" | "SENDING" | "NOTIFIED" | "AMBIGUOUS" | "FAILED";
    notificationAttempts: number;
    notifiedAt: Date | null;
    lastNotificationError: string | null;
  } | null;
}

export type CollectionReportRawPosition = CollectionRunBusinessPositionFact;

export interface CollectionReportRawSnapshot extends Omit<CollectionRunBusinessSnapshotFact, "matchCategory"> {
  searchCandidateId: string | null;
  ownListingSkuText: string | null;
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

export interface CollectionReportCompleteFacts {
  ownCatalogCompleteness: OwnCatalogCompleteness;
  positions: CollectionReportRawPosition[];
  snapshots: CollectionReportRawSnapshot[];
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
    request: CollectionReportPageRequest
  ): Promise<CollectionReportPagedResult<CollectionReportRawSnapshot>>;
  loadBusinessFacts(runId: string): Promise<CollectionReportCompleteFacts>;
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
  terminationReason: "LIMIT_REACHED" | "END_MARKER" | null;
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
    sessionState: "READY" | "LOGIN_REQUIRED" | "CHALLENGE_REQUIRED" | "UNAVAILABLE";
    sessionObservedAt: string | null;
    sessionChangedAt: string | null;
  } | null;
  completion: CollectionRunCompletion;
  notification: {
    state: "NOT_CREATED" | "PENDING" | "SENDING" | "NOTIFIED" | "AMBIGUOUS" | "FAILED";
    attempts: number;
    notifiedAt: string | null;
    lastError: string | null;
  };
  error: { code: string; message: string | null } | null;
}

export type CollectionRunSkuReportRow = CollectionRunBusinessSkuRow;

export interface CollectionRunReportDetail extends CollectionRunReportSummary, CollectionRunBusinessSections {
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

function asStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function attributesFromEvidence(value: unknown): Record<string, string> {
  const attributes = asRecord(asRecord(value)?.attributes);
  if (!attributes) return {};
  return Object.fromEntries(
    Object.entries(attributes).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
}

function componentsFromEvidence(value: unknown): CollectionRunBusinessSnapshotFact["components"] {
  const components = asRecord(value)?.components;
  if (!Array.isArray(components) || components.length === 0) return null;
  const parsed: NonNullable<CollectionRunBusinessSnapshotFact["components"]> = [];
  for (const value of components) {
    const component = asRecord(value);
    const role = component?.role;
    const accessoryType = component?.accessoryType;
    const brand = component?.brand;
    const modelOrName = component?.modelOrName;
    const quantity = component?.quantity;
    if (
      (role !== "CORE" && role !== "PAID_ACCESSORY" && role !== "GIFT_OR_SERVICE" && role !== "UNKNOWN")
      || typeof accessoryType !== "string"
      || accessoryType.trim().length === 0
      || (brand !== null && typeof brand !== "string")
      || (typeof brand === "string" && brand.trim().length === 0)
      || typeof modelOrName !== "string"
      || modelOrName.trim().length === 0
      || !Number.isSafeInteger(quantity)
      || (quantity as number) <= 0
    ) return null;
    parsed.push({ role, accessoryType, brand, modelOrName, quantity: quantity as number });
  }
  return parsed;
}

function nonNegativeMoneyOrNull(value: unknown): value is number | null {
  return value === null || (Number.isSafeInteger(value) && (value as number) >= 0);
}

function promotionsFromJson(value: unknown): CollectionRunBusinessSnapshotFact["promotions"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): CollectionRunBusinessSnapshotFact["promotions"] => {
    const promotion = asRecord(entry);
    const kind = promotion?.kind;
    const label = promotion?.label;
    const amountFen = promotion?.amountFen;
    const thresholdFen = promotion?.thresholdFen;
    const audience = promotion?.audience;
    const stackGroup = promotion?.stackGroup;
    const includedInActivityPrice = promotion?.includedInActivityPrice;
    const inclusion = promotion?.activityPriceInclusion;
    if (
      typeof kind !== "string"
      || typeof label !== "string"
      || !nonNegativeMoneyOrNull(amountFen)
      || !nonNegativeMoneyOrNull(thresholdFen)
      || typeof audience !== "string"
      || (stackGroup !== null && typeof stackGroup !== "string")
      || typeof includedInActivityPrice !== "boolean"
      || (inclusion !== undefined && inclusion !== "INCLUDED" && inclusion !== "EXCLUDED" && inclusion !== "UNKNOWN")
    ) return [];
    return [{
      kind,
      label,
      amountFen,
      thresholdFen,
      audience,
      stackGroup,
      includedInActivityPrice,
      activityPriceInclusion: inclusion ?? (includedInActivityPrice ? "INCLUDED" : "UNKNOWN")
    }];
  });
}

function giftsFromJson(value: unknown): CollectionRunBusinessSnapshotFact["gifts"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): CollectionRunBusinessSnapshotFact["gifts"] => {
    const gift = asRecord(entry);
    const name = gift?.name;
    const quantity = gift?.quantity;
    return typeof name === "string" && name.trim().length > 0
      && Number.isSafeInteger(quantity) && (quantity as number) > 0
      ? [{ name, quantity: quantity as number }]
      : [];
  });
}

function combinationReasonsFromJson(value: unknown): string[] {
  return asStringList(asRecord(value)?.codes);
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
  const verifiedCoverage = run.searchTerminationReason === "END_MARKER"
    || run.searchTerminationReason === "LIMIT_REACHED"
    || (run.searchTerminationReason === null && positionsCaptured >= requestedPositions);
  const complete = run.status === "SUCCEEDED" && verifiedCoverage && incompleteCount === 0;
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
    terminationReason: run.searchTerminationReason,
    complete,
    label: complete && run.searchTerminationReason === "END_MARKER"
      ? `${positionsCaptured} 项，已验证到底`
      : complete && run.searchTerminationReason === "LIMIT_REACHED"
        ? `${positionsCaptured} / ${requestedPositions}，已达上限`
        : complete
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
      appVersion: run.collectorAgent.appVersion,
      sessionState: run.collectorAgent.sessionState,
      sessionObservedAt: run.collectorAgent.sessionObservedAt?.toISOString() ?? null,
      sessionChangedAt: run.collectorAgent.sessionChangedAt?.toISOString() ?? null
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

const reportRunSummarySelect = {
  id: true,
  status: true,
  providerKey: true,
  scheduledFor: true,
  startedAt: true,
  finishedAt: true,
  searchLimit: true,
  searchTerminationReason: true,
  ownBaselineSnapshotId: true,
  claimedOwnListingIds: true,
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
  collectorAgent: {
    select: {
      id: true,
      name: true,
      platform: true,
      appVersion: true,
      sessionState: true,
      sessionObservedAt: true,
      sessionChangedAt: true
    }
  },
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
  combinationSignature: true,
  combinationLabel: true,
  combinationState: true,
  combinationReasons: true,
  comparisonOwnSnapshotId: true,
  promotions: true,
  gifts: true,
  rawEvidence: true,
  evidenceUrl: true,
  evidenceKey: true,
  capturedAt: true,
  ownListing: { select: { skuText: true, url: true } },
  searchCandidate: { select: { url: true } },
  comparisonOwnSnapshot: {
    select: {
      id: true,
      ownListingId: true,
      platformItemId: true,
      skuId: true,
      payableFen: true,
      combinationSignature: true,
      ownListing: { select: { url: true } }
    }
  }
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
    searchTerminationReason: run.searchTerminationReason,
    ownBaselineSnapshotId: run.ownBaselineSnapshotId,
    claimedOwnListingIds: [...run.claimedOwnListingIds],
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
  const {
    ownListing,
    searchCandidate,
    comparisonOwnSnapshot: _comparisonOwnSnapshot,
    rawEvidence,
    promotions,
    gifts,
    combinationReasons,
    evidenceUrl,
    ...row
  } = snapshot;
  return {
    ...row,
    ownListingSkuText: ownListing?.skuText ?? null,
    url: ownListing?.url ?? searchCandidate?.url ?? evidenceUrl ?? "",
    attributes: attributesFromEvidence(rawEvidence),
    components: componentsFromEvidence(rawEvidence),
    promotions: promotionsFromJson(promotions),
    gifts: giftsFromJson(gifts),
    combinationReasons: combinationReasonsFromJson(combinationReasons),
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
  filters: CollectionRunReportFilters
): Prisma.Sql {
  const clauses: Prisma.Sql[] = [Prisma.sql`s."collectionRunId" = ${run.id}`];
  if (filters.source === "OWN") clauses.push(Prisma.sql`s."ownListingId" IS NOT NULL`);
  if (filters.source === "COMPETITOR") clauses.push(Prisma.sql`s."ownListingId" IS NULL`);
  if (filters.confidence) clauses.push(Prisma.sql`s."priceConfidence"::text = ${filters.confidence}`);
  if (filters.combinationState === "REVIEW") {
    clauses.push(Prisma.sql`(s."combinationState"::text = 'REVIEW' OR s."combinationState" IS NULL)`);
  } else if (filters.combinationState) {
    clauses.push(Prisma.sql`s."combinationState"::text = ${filters.combinationState}`);
  }

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
    clauses.push(Prisma.sql`s."ownListingId" IS NULL`);
    clauses.push(Prisma.sql`s."combinationState"::text = 'MATCHED'`);
    clauses.push(Prisma.sql`s."comparisonOwnSnapshotId" IS NOT NULL`);
    clauses.push(Prisma.sql`s."combinationSignature" IS NOT NULL`);
    clauses.push(Prisma.sql`selected_own."ownListingId" IS NOT NULL`);
    clauses.push(Prisma.sql`selected_own."combinationSignature" = s."combinationSignature"`);
    clauses.push(Prisma.sql`s."priceConfidence"::text = 'CONFIRMED'`);
    clauses.push(Prisma.sql`selected_own."priceConfidence"::text = 'CONFIRMED'`);
    clauses.push(Prisma.sql`s."stockState"::text = 'IN_STOCK'`);
    clauses.push(Prisma.sql`selected_own."stockState"::text = 'IN_STOCK'`);
    clauses.push(Prisma.sql`s."payableFen" IS NOT NULL`);
    clauses.push(Prisma.sql`s."payableFen" >= 0`);
    clauses.push(Prisma.sql`selected_own."payableFen" IS NOT NULL`);
    clauses.push(Prisma.sql`selected_own."payableFen" >= 0`);
    clauses.push(filters.price === "LOWER"
      ? Prisma.sql`s."payableFen" < selected_own."payableFen"`
      : Prisma.sql`s."payableFen" >= selected_own."payableFen"`);
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
    if (!run.ownBaselineSnapshotId) return null;
    const snapshot = await this.prisma.offerSnapshot.findFirst({
      where: { id: run.ownBaselineSnapshotId, collectionRunId: run.id },
      select: snapshotSelect
    });
    return snapshot ? toRawSnapshot(snapshot) : null;
  }

  async listSnapshots(
    run: CollectionReportRawRun,
    filters: CollectionRunReportFilters,
    input: CollectionReportPageRequest
  ): Promise<CollectionReportPagedResult<CollectionReportRawSnapshot>> {
    const request = normalizePageRequest(input, COLLECTION_REPORT_DETAIL_DEFAULT_PAGE_SIZE);
    const whereSql = snapshotFilterSql(run, filters);
    const [idRows, countRows] = await Promise.all([
      this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT s."id"
        FROM "OfferSnapshot" s
        LEFT JOIN "OfferSnapshot" selected_own
          ON selected_own."id" = s."comparisonOwnSnapshotId"
          AND selected_own."collectionRunId" = s."collectionRunId"
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
        LEFT JOIN "OfferSnapshot" selected_own
          ON selected_own."id" = s."comparisonOwnSnapshotId"
          AND selected_own."collectionRunId" = s."collectionRunId"
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

  async loadBusinessFacts(runId: string): Promise<CollectionReportCompleteFacts> {
    const run = await this.prisma.collectionRun.findUniqueOrThrow({
      where: { id: runId },
      select: { claimedOwnListingIds: true }
    });
    const [positions, snapshots, claimedOwnListings, issues] = await Promise.all([
      this.prisma.collectionSearchPosition.findMany({
        where: { collectionRunId: runId },
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
      }),
      this.prisma.offerSnapshot.findMany({
        where: { collectionRunId: runId },
        select: snapshotSelect,
        orderBy: [{ createdAt: "asc" }, { id: "asc" }]
      }),
      this.prisma.ownListing.findMany({
        where: { id: { in: run.claimedOwnListingIds } },
        select: { id: true, platformItemId: true }
      }),
      this.prisma.collectionIssue.findMany({
        where: { collectionRunId: runId },
        select: { code: true, platformItemId: true, skuId: true }
      })
    ]);
    const claimedListingById = new Map(claimedOwnListings.map((listing) => [listing.id, listing]));
    return {
      ownCatalogCompleteness: deriveOwnCatalogCompleteness({
        claimedOwnListings: run.claimedOwnListingIds.map((id) => ({
          id,
          platformItemId: claimedListingById.get(id)?.platformItemId ?? null
        })),
        ownSnapshots: snapshots.map((snapshot) => ({
          ownListingId: snapshot.ownListingId,
          platformItemId: snapshot.platformItemId,
          skuId: snapshot.skuId
        })),
        issues
      }),
      positions,
      snapshots: snapshots.map(toRawSnapshot)
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

    const positionsPromise = this.repository.listPositions(runId, positionRequest);
    const issuesPromise = this.repository.listIssues(runId, issueRequest);
    const snapshotsPromise = this.repository.listSnapshots(run, filters, skuRequest);
    const businessFactsPromise = this.repository.loadBusinessFacts(runId);
    const [positions, issues, snapshots, businessFacts] = await Promise.all([
      positionsPromise,
      issuesPromise,
      snapshotsPromise,
      businessFactsPromise
    ]);
    const rankRows = await this.repository.listRanks(runId, snapshots.items.map((snapshot) => snapshot.platformItemId));
    const ranks = new Map<string, number[]>();
    for (const row of rankRows) {
      ranks.set(row.platformItemId, row.ranks);
    }
    const aggregationInput: CollectionRunBusinessAggregationInput = {
      ownCatalogCompleteness: businessFacts.ownCatalogCompleteness,
      positions: businessFacts.positions,
      snapshots: businessFacts.snapshots.map((snapshot) => ({
        ...snapshot,
        matchCategory: matchCategory(run, snapshot)
      }))
    };
    const businessSections = aggregateCollectionRunReport(aggregationInput);
    const completeRows = new Map(
      projectCollectionRunBusinessSkuRows(aggregationInput).map((row) => [row.id, row])
    );

    return {
      ...summary(run),
      ...businessSections,
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
      skus: snapshots.items.flatMap((snapshot) => {
        const row = completeRows.get(snapshot.id);
        return row ? [{ ...row, ranks: [...(ranks.get(snapshot.platformItemId) ?? row.ranks)] }] : [];
      }),
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
