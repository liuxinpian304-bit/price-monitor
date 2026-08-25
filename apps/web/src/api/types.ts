import type { AlertStatus } from "../data/demo-data.ts";

export interface ApiAlert {
  id: string;
  monitorCode: string;
  brand: string;
  model: string;
  type: "BARE" | "BUNDLE";
  sku: string;
  ownSku: string;
  ownPriceFen: number | null;
  ownShop: string;
  competitorPriceFen: number | null;
  competitorShop: string;
  competitorUrl: string;
  differenceFen: number | null;
  foundAt: string;
  lastSeenAt: string;
  status: AlertStatus;
  severity: "CONFIRMED_LOW" | "MANUAL_REVIEW" | "SYSTEM_ERROR";
  owner: string;
  reasons: string[];
  notifiedAt: string | null;
  notificationAttempts: number;
  lastNotificationError: string | null;
}

export interface CatalogModel {
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
  ownUrl: string;
  ownSkuText: string;
  comparisonType: "BARE" | "BUNDLE";
  bundleCode: string | null;
  colorComparable: boolean;
  owner: string;
  notes: string | null;
}

export interface DashboardData {
  stats: {
    scansToday: number;
    plannedScans: number;
    monitoredModels: number;
    lowEvents: number;
    pendingAlerts: number;
    failedRuns: number;
  };
  schedule: Array<{ time: string; status: "DONE" | "RUNNING" | "WAITING" }>;
  latestAlerts: ApiAlert[];
  timeZone: string;
}

export interface ComparisonRow {
  id: string;
  monitorCode: string;
  model: string;
  sku: string;
  ownPriceFen: number | null;
  competitorPriceFen: number | null;
  competitorShop: string | null;
  competitorUrl: string | null;
  stock: string;
  updatedAt: string;
}

export interface ManualCandidate {
  id: string;
  model: string;
  title: string;
  sku: string;
  shop: string;
  reason: string;
  foundAt: string;
  url: string;
}

export interface HistoryRow {
  id: string;
  model: string;
  type: "BARE" | "BUNDLE";
  sku: string;
  payableFen: number | null;
  shop: string;
  stock: string;
  capturedAt: string;
  evidenceUrl: string;
}

export interface PublicSettings {
  shopName: string;
  provider: "manual" | "external" | "desktop";
  schedulerEnabled: boolean;
  checkTimes: string[];
  timeZone: string;
  wecomWebhookConfigured: boolean;
  commerceApiKeyConfigured: boolean;
}

export interface HealthData {
  status: "ok" | "degraded";
  database: "up" | "down";
  redis: "up" | "down";
  queue?: "up" | "down";
  collectorAgent?: "up" | "down";
  runtime?: "ASSEMBLED" | "PROTOTYPE";
}

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

export interface CollectionRunDetailPaginationInput {
  positionPage?: number;
  positionPageSize?: number;
  issuePage?: number;
  issuePageSize?: number;
  skuPage?: number;
  skuPageSize?: number;
}

export interface CollectionReportPageMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasPrevious: boolean;
  hasNext: boolean;
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

export interface CollectionRunReportSku {
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
  skus: CollectionRunReportSku[];
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
