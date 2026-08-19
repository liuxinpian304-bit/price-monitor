import type { ApiAlert, ComparisonRow, HistoryRow } from "../../api/types.ts";

export type HistoryTypeFilter = "ALL" | "BARE" | "BUNDLE";
export type DateRange = [Date, Date] | null;

function normalized(value: string | null | undefined) {
  return (value ?? "").trim().toLocaleLowerCase("zh-CN");
}

function matchesQuery(query: string, values: Array<string | null | undefined>) {
  const needle = normalized(query);
  return needle.length === 0 || values.some((value) => normalized(value).includes(needle));
}

export function filterAlerts(rows: ApiAlert[], query: string) {
  return rows.filter((row) => matchesQuery(query, [row.monitorCode, row.brand, row.model, row.sku, row.competitorShop]));
}

export function filterComparisons(rows: ComparisonRow[], query: string) {
  return rows.filter((row) => matchesQuery(query, [row.monitorCode, row.model, row.sku, row.competitorShop]));
}

export function filterHistory(rows: HistoryRow[], type: HistoryTypeFilter, range: DateRange) {
  return rows.filter((row) => {
    if (type !== "ALL" && row.type !== type) return false;
    if (!range) return true;

    const capturedAt = new Date(row.capturedAt).getTime();
    return Number.isFinite(capturedAt) && capturedAt >= range[0].getTime() && capturedAt <= range[1].getTime();
  });
}

export function formatDateTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "--" : date.toLocaleString("zh-CN", { hour12: false });
}

function csvCell(value: string | number | null) {
  let text = value === null ? "" : String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function yuan(value: number | null) {
  return value === null ? "" : (value / 100).toFixed(2);
}

export function buildComparisonCsv(rows: ComparisonRow[]) {
  const table: Array<Array<string | number | null>> = [
    ["监控编号", "型号", "具体SKU", "我方到手价(元)", "同行最低价(元)", "同行店铺", "库存", "更新时间"],
    ...rows.map((row) => [
      row.monitorCode,
      row.model,
      row.sku,
      yuan(row.ownPriceFen),
      yuan(row.competitorPriceFen),
      row.competitorShop,
      row.stock,
      formatDateTime(row.updatedAt)
    ])
  ];

  return table.map((row) => row.map(csvCell).join(",")).join("\r\n");
}
