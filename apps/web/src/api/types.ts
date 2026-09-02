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
export type CollectionRunReportCombinationState = "OWN" | "MATCHED" | "MISSING_OWN" | "REVIEW" | "EXCLUDED";

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

export type CollectionRunComponentRole = "CORE" | "PAID_ACCESSORY" | "GIFT_OR_SERVICE" | "UNKNOWN";

export interface CollectionRunSkuComponent {
  role: CollectionRunComponentRole;
  accessoryType: string;
  brand: string | null;
  modelOrName: string;
  quantity: number;
}

export interface CollectionRunPromotion {
  kind: string;
  label: string;
  amountFen: number | null;
  thresholdFen: number | null;
  audience: string;
  stackGroup: string | null;
  includedInActivityPrice: boolean;
  activityPriceInclusion: "INCLUDED" | "EXCLUDED" | "UNKNOWN";
}

export interface CollectionRunGift {
  name: string;
  quantity: number;
}

export interface CollectionRunBusinessPrices {
  listPriceFen: number | null;
  activityPriceFen: number | null;
  couponDiscountFen: number;
  fullReductionFen: number;
  directDiscountFen: number;
  mandatoryFeeFen: number;
  publicDiscountFen: number;
  payableFen: number | null;
}

export interface CollectionRunBusinessPosition {
  rank: number;
  platformItemId: string;
  url: string;
  shopName: string;
  title: string;
  displayPriceMinFen: number;
  displayPriceMaxFen: number;
  sponsored: boolean;
  capturedAt: string;
}

export interface CollectionRunOwnSnapshotSummary {
  id: string;
  ownListingId: string;
  platformItemId: string;
  skuId: string | null;
  shopName: string;
  title: string;
  skuText: string | null;
  url: string;
  attributes: Record<string, string>;
  components: CollectionRunSkuComponent[] | null;
  promotions: CollectionRunPromotion[];
  gifts: CollectionRunGift[];
  prices: CollectionRunBusinessPrices;
  stockState: "IN_STOCK" | "OUT_OF_STOCK" | "UNKNOWN";
  confidence: CollectionRunReportConfidence;
  combinationSignature: string | null;
  combinationLabel: string | null;
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
  positions: CollectionRunBusinessPosition[];
  attributes: Record<string, string>;
  components: CollectionRunSkuComponent[] | null;
  promotions: CollectionRunPromotion[];
  gifts: CollectionRunGift[];
  prices: CollectionRunBusinessPrices;
  stockState: "IN_STOCK" | "OUT_OF_STOCK" | "UNKNOWN";
  confidence: CollectionRunReportConfidence;
  match: {
    category: CollectionRunReportMatch;
    decision: "PENDING" | "BARE" | "BUNDLE" | "REJECTED" | "MANUAL" | null;
    comparable: boolean;
    confidenceBps: number;
    reasons: string[];
  };
  combination: {
    state: CollectionRunReportCombinationState;
    signature: string | null;
    label: string | null;
    reasons: string[];
  };
  selectedOwnSnapshot: CollectionRunOwnSnapshotSummary | null;
  alternativeOwnSnapshots: CollectionRunOwnSnapshotSummary[];
  differenceFen: number | null;
  comparison: {
    state: "OWN" | "LOWER" | "NOT_LOWER" | "UNDECIDED";
    ownPayableFen: number | null;
    differenceFen: number | null;
  };
  evidenceSha256: string | null;
  capturedAt: string;
}

export interface CollectionRunBusinessItemGroup {
  platformItemId: string;
  shopName: string;
  title: string;
  url: string;
  earliestRank: number;
  ranks: number[];
  positions: CollectionRunBusinessPosition[];
  skuCount: number;
  skus: CollectionRunReportSku[];
}

export interface CollectionRunShopGroup {
  shopName: string;
  earliestRank: number;
  ranks: number[];
  positionCount: number;
  itemCount: number;
  skuCount: number;
  minimumConfirmedPayableFen: number | null;
  confirmedLowCount: number;
  missingCombinationCount: number;
  items: CollectionRunBusinessItemGroup[];
}

export interface CollectionRunConfirmedLow {
  competitorSnapshot: CollectionRunReportSku;
  selectedOwnSnapshot: CollectionRunOwnSnapshotSummary;
  alternativeOwnSnapshots: CollectionRunOwnSnapshotSummary[];
  combinationSignature: string | null;
  combinationLabel: string | null;
  differenceFen: number;
  ranks: number[];
  reasons: string[];
}

export interface CollectionRunMissingOwnGroup {
  combinationSignature: string;
  combinationLabel: string;
  missingReason: "OWN_COMBINATION_ABSENT" | "OWN_OUT_OF_STOCK_ONLY";
  earliestRank: number;
  minimumConfirmedPayableFen: number | null;
  minimumOfferSnapshotId: string | null;
  minimumOfferRank: number | null;
  shops: string[];
  offers: CollectionRunReportSku[];
}

export interface CollectionRunBusinessSummary {
  distinctShopCount: number;
  distinctItemCount: number;
  skuCount: number;
  matchedSkuCount: number;
  confirmedLowCount: number;
  missingCombinationCount: number;
  reviewCount: number;
  excludedCount: number;
  ownConfiguredListingCount: number;
  ownCollectedListingCount: number;
  ownCatalogComplete: boolean;
}

export type CollectionRunReviewRow = CollectionRunReportSku;

export interface CollectionRunBusinessSections {
  businessSummary: CollectionRunBusinessSummary;
  priceBoard: { shops: CollectionRunShopGroup[] };
  confirmedLows: CollectionRunConfirmedLow[];
  missingOwnGroups: CollectionRunMissingOwnGroup[];
  reviewRows: CollectionRunReviewRow[];
}

export interface CollectionRunReportDetail extends CollectionRunReportSummary, CollectionRunBusinessSections {
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

export interface RunAlertNotificationPreview {
  runId: string;
  state: "PENDING" | "SENDING" | "NOTIFIED" | "AMBIGUOUS" | "FAILED";
  markdown: string;
  previewDigest: string;
  liveSendingApproved: boolean;
}
