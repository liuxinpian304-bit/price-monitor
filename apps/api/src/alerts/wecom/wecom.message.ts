import type { PriceAlertRecord } from "../alert.service.ts";

export interface WecomMarkdownMessage {
  msgtype: "markdown";
  markdown: { content: string };
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
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}:${part("second")}`;
}

function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

export function buildWecomPriceAlertMessage(alert: PriceAlertRecord): WecomMarkdownMessage {
  const severity = alert.severity === "CONFIRMED_LOW" ? "确定低价" : "人工核对";
  const comparisonType = alert.comparisonType === "BARE" ? "裸机" : "套装";
  const content = [
    `### 天猫低价预警（${severity}）`,
    `> 型号：${oneLine(alert.brand)} ${oneLine(alert.standardModel)}`,
    `> 类型：${comparisonType}`,
    `> 我方：${oneLine(alert.ownShopName)} / ${oneLine(alert.ownSkuText)} / **${formatFen(alert.ownPriceFen)}**`,
    `> 同行：${oneLine(alert.competitorShopName)} / ${oneLine(alert.competitorSkuText)} / <font color="warning">**${formatFen(alert.competitorPriceFen)}**</font>`,
    `> 价差：**${formatFen(alert.differenceFen)}**`,
    `> 负责人：${oneLine(alert.owner)}`,
    `> 发现时间：${formatShanghaiTime(alert.firstSeenAt)}`,
    `> 依据：${alert.reasons.map(oneLine).join("；")}`,
    `[打开同行商品](${alert.competitorUrl})`
  ].join("\n");
  return { msgtype: "markdown", markdown: { content } };
}
