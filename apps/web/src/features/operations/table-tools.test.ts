import { describe, expect, it } from "vitest";

import type { ApiAlert, ComparisonRow, HistoryRow } from "../../api/types.ts";
import {
  buildComparisonCsv,
  filterAlerts,
  filterComparisons,
  filterHistory,
  formatDateTime
} from "./table-tools.ts";

const comparison: ComparisonRow = {
  id: "comparison-1",
  monitorCode: "MON-0001",
  model: "RME Babyface Pro FS",
  sku: "官方标配",
  ownPriceFen: 730000,
  competitorPriceFen: 729999,
  competitorShop: "同行音频店",
  competitorUrl: "https://detail.tmall.com/item.htm?id=1",
  stock: "有货",
  updatedAt: "2026-08-19T09:30:00+08:00"
};

const alert: ApiAlert = {
  id: "alert-1",
  monitorCode: "MON-0001",
  brand: "RME",
  model: "RME Babyface Pro FS",
  type: "BARE",
  sku: "官方标配",
  ownSku: "官方标配",
  ownPriceFen: 730000,
  ownShop: "星空乐器专营店",
  competitorPriceFen: 729999,
  competitorShop: "同行音频店",
  competitorUrl: "https://detail.tmall.com/item.htm?id=1",
  differenceFen: 1,
  foundAt: "2026-08-19T09:30:00+08:00",
  lastSeenAt: "2026-08-19T09:30:00+08:00",
  status: "PENDING",
  severity: "CONFIRMED_LOW",
  owner: "张三",
  reasons: [],
  notifiedAt: null,
  notificationAttempts: 0,
  lastNotificationError: null
};

const history: HistoryRow = {
  id: "history-1",
  model: "RME Babyface Pro FS",
  type: "BARE",
  sku: "官方标配",
  payableFen: 729999,
  shop: "同行音频店",
  stock: "有货",
  capturedAt: "2026-08-19T09:30:00+08:00",
  evidenceUrl: "https://detail.tmall.com/item.htm?id=1"
};

describe("operations table tools", () => {
  it("filters alerts and comparisons by model, SKU or shop without case sensitivity", () => {
    expect(filterAlerts([alert], "babyface")).toEqual([alert]);
    expect(filterAlerts([alert], "不存在")).toEqual([]);
    expect(filterComparisons([comparison], "同行音频")).toEqual([comparison]);
    expect(filterComparisons([comparison], "不存在")).toEqual([]);
  });

  it("filters history by type and inclusive date range", () => {
    expect(filterHistory([history], "BARE", [new Date("2026-08-19T00:00:00+08:00"), new Date("2026-08-19T23:59:59+08:00")])).toEqual([history]);
    expect(filterHistory([history], "BUNDLE", null)).toEqual([]);
    expect(filterHistory([history], "ALL", [new Date("2026-08-20T00:00:00+08:00"), new Date("2026-08-20T23:59:59+08:00")])).toEqual([]);
  });

  it("exports readable CSV and formats ISO timestamps for operators", () => {
    const csv = buildComparisonCsv([comparison]);

    expect(csv).toContain("监控编号,型号,具体SKU");
    expect(csv).toContain("MON-0001,RME Babyface Pro FS,官方标配");
    expect(formatDateTime(alert.foundAt)).toContain("2026");
    expect(formatDateTime(alert.foundAt)).not.toContain("T09:30");
  });
});
