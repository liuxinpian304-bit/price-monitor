import type {
  ApiAlert,
  CatalogModel,
  ComparisonRow,
  DashboardData,
  HistoryRow,
  ManualCandidate,
  PublicSettings
} from "../api/types.ts";
import { alerts, comparisons, models, schedule } from "./demo-data.ts";

export const fallbackAlerts: ApiAlert[] = alerts.map((alert, index) => ({
  id: alert.id,
  monitorCode: alert.monitorCode,
  brand: alert.model.split(" ")[0] ?? "",
  model: alert.model,
  type: alert.type,
  sku: alert.sku,
  ownSku: alert.sku,
  ownPriceFen: alert.ownPriceFen,
  ownShop: "星空乐器专营店",
  competitorPriceFen: alert.competitorPriceFen,
  competitorShop: alert.competitorShop,
  competitorUrl: alert.competitorUrl,
  differenceFen: alert.ownPriceFen - alert.competitorPriceFen,
  foundAt: alert.foundAt.replace(" ", "T") + "+08:00",
  lastSeenAt: alert.foundAt.replace(" ", "T") + "+08:00",
  status: alert.status,
  severity: alert.severity,
  owner: alert.owner,
  reasons: ["同品牌、同型号、同版本，具体 SKU 到手价已确认"],
  notifiedAt: null,
  notificationAttempts: 0,
  lastNotificationError: null
}));

export const fallbackCatalog: CatalogModel[] = models.map((model) => ({
  id: model.code,
  monitorCode: model.code,
  enabled: model.enabled,
  brand: model.brand,
  standardModel: model.model,
  category: model.category,
  searchQuery: `${model.brand} ${model.model}`,
  version: model.model.includes("Babyface") ? "FS新版" : null,
  mustIncludeTerms: model.model.split(/\s+/).filter(Boolean),
  excludedTerms: ["二手", "租赁", "定金", "维修"],
  ownUrl: "https://example.com/demo/1",
  ownSkuText: "官方标配",
  comparisonType: model.type === "裸机" ? "BARE" : "BUNDLE",
  bundleCode: model.type === "套装" ? `BUNDLE-${model.code}` : null,
  colorComparable: false,
  owner: model.owner,
  notes: null
}));

export const fallbackComparisons: ComparisonRow[] = comparisons.map((row) => ({
  id: row.key,
  monitorCode: row.monitorCode,
  model: row.model,
  sku: row.sku,
  ownPriceFen: row.own,
  competitorPriceFen: row.competitor,
  competitorShop: row.shop,
  competitorUrl: "https://example.com/demo/2",
  stock: row.stock,
  updatedAt: `2026-08-19T${row.updated}+08:00`
}));

export const fallbackManualCandidates: ManualCandidate[] = [
  { id: "c1", model: "RME Babyface Pro FS", title: "RME Babyface Pro FS 专业录音声卡", sku: "Babyface Pro FS", shop: "示例同行店A", reason: "未识别到裸机或套装信号", foundAt: "2026-08-19T09:30:11+08:00", url: "https://example.com/demo/3" },
  { id: "c2", model: "Kali LP-UNF", title: "Kali LP-UNF 监听音箱", sku: "黑色", shop: "示例同行店B", reason: "无法确认单只或一对", foundAt: "2026-08-19T09:30:16+08:00", url: "https://example.com/demo/4" }
];

export const fallbackHistory: HistoryRow[] = fallbackComparisons.map((row) => ({
  id: row.id,
  model: row.model,
  type: "BARE",
  sku: row.sku,
  payableFen: row.competitorPriceFen,
  shop: row.competitorShop ?? "示例同行店A",
  stock: row.stock,
  capturedAt: row.updatedAt,
  evidenceUrl: row.competitorUrl ?? ""
}));

export const fallbackDashboard: DashboardData = {
  stats: { scansToday: 8, plannedScans: 12, monitoredModels: 36, lowEvents: 7, pendingAlerts: 5, failedRuns: 1 },
  schedule,
  latestAlerts: fallbackAlerts.slice(0, 4),
  timeZone: "Asia/Shanghai"
};

export const fallbackSettings: PublicSettings = {
  shopName: "星空乐器专营店",
  provider: "manual",
  schedulerEnabled: true,
  checkTimes: schedule.map((item) => item.time),
  timeZone: "Asia/Shanghai",
  wecomWebhookConfigured: false,
  commerceApiKeyConfigured: false
};
