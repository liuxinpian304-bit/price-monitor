import type {
  RunAlertEntry,
  RunAlertMissingOwnGroup,
  RunAlertSummary
} from "../../collection/run-alert.service.ts";

const WECOM_CONTENT_LIMIT = 3_500;
const DETAIL_LIMIT = 10;

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function truncate(value: string, maximum: number): string {
  const points = Array.from(value);
  if (points.length <= maximum) return value;
  return `${points.slice(0, Math.max(0, maximum - 1)).join("")}…`;
}

const markdownReplacement: Record<string, string> = {
  "<": "＜",
  ">": "＞",
  "[": "［",
  "]": "］",
  "(": "（",
  ")": "）",
  "*": "＊",
  "_": "＿",
  "`": "｀",
  "#": "＃",
  "|": "｜"
};

function oneLine(value: string, maximum = 240): string {
  return truncate(
    value
      .replace(/[\r\n\t]+/g, " ")
      .replace(/[<>\[\]()*_`#|]/g, (character) => markdownReplacement[character]!)
      .replace(/\s+/g, " ")
      .trim(),
    maximum
  );
}

function safeUrl(value: string, maximum = 128): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    if (url.username || url.password) return "";
    const safe = url.toString().replaceAll(")", "%29");
    return codePointLength(safe) <= maximum ? safe : "";
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

function compareText(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function compareRank(left: number | null, right: number | null): number {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left - right;
}

function rankText(rank: number | null): string {
  return rank === null ? "排名未知" : `排名 ${rank}`;
}

function comparisonLabel(summary: RunAlertSummary): string {
  return summary.comparisonType === "BARE" ? "裸机" : "套装";
}

function reportLine(summary: RunAlertSummary): string {
  const url = safeUrl(summary.reportUrl, 320);
  return url ? `[查看完整报告](${url})` : "完整报告入口暂不可用";
}

function confirmedLows(summary: RunAlertSummary): RunAlertEntry[] {
  return summary.alerts
    .filter((alert) => alert.severity === "CONFIRMED_LOW")
    .sort((left, right) => (
      right.differenceFen - left.differenceFen
      || compareRank(left.rank, right.rank)
      || compareText(left.shopName, right.shopName)
      || compareText(left.combinationSignature, right.combinationSignature)
      || compareText(left.alertId, right.alertId)
    ));
}

function sortedMissingGroups(summary: RunAlertSummary): RunAlertMissingOwnGroup[] {
  return [...summary.missingOwnGroups].sort((left, right) => (
    left.minimumConfirmedPayableFen - right.minimumConfirmedPayableFen
    || compareRank(left.earliestRank, right.earliestRank)
    || compareText(left.combinationSignature, right.combinationSignature)
  ));
}

function commonLines(
  summary: RunAlertSummary,
  lowCount: number,
  missingCount: number
): string[] {
  return [
    `> 型号 ${oneLine(summary.brand, 72)} ${oneLine(summary.standardModel, 96)} / ${comparisonLabel(summary)}`,
    `> 上海时间 ${formatShanghaiTime(summary.completedAt)} / 前50位置 ${summary.positionCount}/${summary.searchLimit}`,
    `> 店铺 ${summary.shopCount} / 商品 ${summary.checkedItemCount} / SKU ${summary.skuCount} / 确认低价 ${lowCount} / 缺失组合 ${missingCount} / 人工复核 ${summary.reviewCount} / 异常 ${summary.issueCount}`
  ];
}

function lowLine(alert: RunAlertEntry, index: number): string {
  const url = safeUrl(alert.url);
  const link = url ? `｜[商品](${url})` : "";
  return `${index + 1}. 同行低价｜${rankText(alert.rank)}｜${oneLine(alert.shopName, 24)}｜${oneLine(alert.combinationLabel, 42)}｜同行 ${formatFen(alert.payableFen)}｜我方 ${formatFen(alert.ownPayableFen)}（${oneLine(alert.ownSkuText, 36)}）｜价差 ${formatFen(alert.differenceFen)}${link}`;
}

function missingLine(group: RunAlertMissingOwnGroup, index: number): string {
  const url = safeUrl(group.representativeUrl);
  const link = url ? `｜[商品](${url})` : "";
  return `${index + 1}. 缺失组合：${oneLine(group.combinationLabel, 42)}｜店铺 ${group.shopCount}｜最低确认价 ${formatFen(group.minimumConfirmedPayableFen)}｜${rankText(group.earliestRank)}${link}`;
}

function contentLines(
  base: string[],
  lows: string[],
  missing: string[],
  report: string
): string[] {
  return [
    ...base,
    "#### 确认低价（最多10）",
    ...(lows.length > 0 ? lows : ["无确认低价"]),
    "#### 我方缺失组合（最多10）",
    ...(missing.length > 0 ? missing : ["无缺失组合"]),
    report
  ];
}

function boundedSummary(base: string[], lows: string[], missing: string[], report: string): string {
  const selectedLows = lows.slice(0, DETAIL_LIMIT);
  const selectedMissing = missing.slice(0, DETAIL_LIMIT);
  let content = contentLines(base, selectedLows, selectedMissing, report).join("\n");

  while (codePointLength(content) > WECOM_CONTENT_LIMIT && (selectedLows.length || selectedMissing.length)) {
    const lowLength = selectedLows.reduce((total, line) => total + codePointLength(line), 0);
    const missingLength = selectedMissing.reduce((total, line) => total + codePointLength(line), 0);
    if (selectedMissing.length > 0 && (selectedLows.length === 0 || missingLength >= lowLength)) {
      selectedMissing.pop();
    } else {
      selectedLows.pop();
    }
    content = contentLines(base, selectedLows, selectedMissing, report).join("\n");
  }

  if (codePointLength(content) <= WECOM_CONTENT_LIMIT) return content;
  const maximumBody = WECOM_CONTENT_LIMIT - codePointLength(report) - 1;
  return `${truncate(contentLines(base, [], [], report).slice(0, -1).join("\n"), maximumBody)}\n${report}`;
}

export function buildWecomRunSummary(summary: RunAlertSummary): string {
  const lows = confirmedLows(summary);
  const missing = sortedMissingGroups(summary);
  const heading = summary.systemIssue === null
    ? "### 淘宝前50 SKU 比价摘要"
    : "### 淘宝前50 SKU 比价系统提醒";
  const base = [heading, ...commonLines(summary, lows.length, missing.length)];

  if (summary.systemIssue !== null) {
    const issue = summary.systemIssue === "OWN_BASELINE_MISSING"
      ? "我方基准缺失或不可用，本次未形成同行价格结论"
      : "我方基准存在多个匹配，本次未形成同行价格结论";
    return boundedSummary([...base, `> ${issue}`], [], [], reportLine(summary));
  }

  return boundedSummary(
    base,
    lows.map(lowLine),
    missing.map(missingLine),
    reportLine(summary)
  );
}
