import type { RunAlertEntry, RunAlertSummary } from "../../collection/run-alert.service.ts";

const WECOM_CONTENT_LIMIT = 3_500;

function codePointLength(value: string): number {
  return Array.from(value).length;
}
function truncate(value: string, maximum: number): string {
  const points = Array.from(value);
  if (points.length <= maximum) return value;
  return `${points.slice(0, Math.max(0, maximum - 1)).join("")}…`;
}

function oneLine(value: string, maximum = 240): string {
  return truncate(
    value
      .replace(/[\r\n\t]+/g, " ")
      .replace(/[<>]/g, (character) => character === "<" ? "＜" : "＞")
      .replace(/\s+/g, " ")
      .trim(),
    maximum
  );
}

function safeUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    return url.toString().replaceAll(")", "%29");
  } catch {
    return "";
  }
}

function formatFen(fen: number): string {
  const yuan = Math.floor(fen / 100);
  const cents = String(fen % 100).padStart(2, "0");
  return `¥${yuan}.${cents}`;
}

function formatShanghaiTime(value: Date): string {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}:${part("second")}`;
}

function comparisonLabel(summary: RunAlertSummary): string {
  return summary.comparisonType === "BARE" ? "裸机" : "套装";
}

function reportLine(summary: RunAlertSummary): string {
  const url = safeUrl(summary.reportUrl);
  return url ? `[查看完整报告](${url})` : "完整报告入口暂不可用";
}

function commonLines(summary: RunAlertSummary): string[] {
  return [
    `> 型号：${oneLine(summary.brand, 80)} ${oneLine(summary.standardModel, 120)} / ${comparisonLabel(summary)}`,
    `> 完成：${summary.checkedItemCount}/${summary.searchLimit} 个商品，${summary.skuCount} 个 SKU，异常 ${summary.issueCount}`,
    `> 时间：${formatShanghaiTime(summary.completedAt)}`
  ];
}

function baselineLine(summary: RunAlertSummary): string {
  const baseline = summary.baseline!;
  return `> 我方：${oneLine(baseline.skuText, 180)} / 活动价 ${formatFen(baseline.activityPriceFen)} / 公开优惠 ${formatFen(baseline.publicDiscountFen)} / 到手价 **${formatFen(baseline.payableFen)}**`;
}

function detailLines(alert: RunAlertEntry, index: number): string[] {
  const rank = alert.rank === null ? "排名未知" : `排名 ${alert.rank}`;
  const url = safeUrl(alert.url);
  return [
    `**${index + 1}. ${alert.severity === "CONFIRMED_LOW" ? "同行低价" : "人工复核"} / ${rank} / ${oneLine(alert.shopName, 120)}**`,
    `> 商品：${oneLine(alert.title, 220)}`,
    `> SKU：${oneLine(alert.skuText, 180)}`,
    `> 活动价 ${formatFen(alert.activityPriceFen)} / 公开优惠 ${formatFen(alert.publicDiscountFen)} / 到手价 <font color="warning">**${formatFen(alert.payableFen)}**</font> / 价差 **${formatFen(alert.differenceFen)}**`,
    `> 依据：${oneLine(alert.reasons.join("；"), 240)}`,
    url ? `[打开同行商品](${url})` : "同行商品链接不可用"
  ];
}

function boundedWithReport(lines: string[], summary: RunAlertSummary): string {
  const report = reportLine(summary);
  const maximumBody = WECOM_CONTENT_LIMIT - codePointLength(report) - 2;
  const body = truncate(lines.join("\n"), Math.max(0, maximumBody));
  return `${body}\n${report}`;
}

function compactAlertLine(alert: RunAlertEntry, index: number): string {
  const rank = alert.rank === null ? "排名未知" : `排名 ${alert.rank}`;
  return `${index + 1}. ${rank} / ${oneLine(alert.shopName, 60)} / ${oneLine(alert.skuText, 100)} / 到手 ${formatFen(alert.payableFen)} / 价差 ${formatFen(alert.differenceFen)}`;
}

function fallbackSummary(summary: RunAlertSummary): string {
  const largest = [...summary.alerts]
    .sort((left, right) => right.differenceFen - left.differenceFen || left.alertId.localeCompare(right.alertId))
    .slice(0, 5);
  const lines = [
    "### 淘宝全 SKU 比价摘要",
    ...commonLines(summary),
    baselineLine(summary),
    `> 共 ${summary.alerts.length} 个新事件，以下为价差最大 5 个：`,
    ...largest.map(compactAlertLine)
  ];
  return boundedWithReport(lines, summary);
}

export function buildWecomRunSummary(summary: RunAlertSummary): string {
  if (summary.systemIssue !== null) {
    const issue = summary.systemIssue === "OWN_BASELINE_MISSING"
      ? "我方基准缺失或不可用，本次未形成同行价格结论"
      : "我方基准存在多个匹配，本次未形成同行价格结论";
    return boundedWithReport([
      "### 淘宝全 SKU 比价系统提醒",
      ...commonLines(summary),
      `> ${issue}`
    ], summary);
  }

  const full = [
    "### 淘宝全 SKU 比价提醒",
    ...commonLines(summary),
    baselineLine(summary),
    ...summary.alerts.flatMap(detailLines),
    reportLine(summary)
  ].join("\n");
  return codePointLength(full) < WECOM_CONTENT_LIMIT ? full : fallbackSummary(summary);
}
