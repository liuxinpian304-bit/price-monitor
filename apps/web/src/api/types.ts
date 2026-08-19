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
  provider: "manual" | "external";
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
}
