import type { WecomMarkdownMessage } from "./wecom.message.ts";

export type CollectorSessionBlockedState = "LOGIN_REQUIRED" | "CHALLENGE_REQUIRED";

export interface WecomCollectorSessionMessageInput {
  agentName: string;
  state: CollectorSessionBlockedState;
  openedAt: string;
}

const sensitiveAgentName = /cookie|token|authorization|webhook|二维码/i;

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

function truncate(value: string, maximum: number): string {
  const points = Array.from(value);
  if (points.length <= maximum) return value;
  return `${points.slice(0, maximum - 1).join("")}…`;
}

function safeAgentName(value: string): string {
  const flattened = value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!flattened || sensitiveAgentName.test(flattened)) return "固定采集设备";
  return truncate(
    flattened.replace(/[<>\[\]()*_`#|]/g, (character) => markdownReplacement[character]!),
    80
  );
}

function formatShanghaiTime(value: string): string {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}:${part("second")}`;
}

export function buildWecomCollectorSessionMessage(
  input: WecomCollectorSessionMessageInput
): WecomMarkdownMessage {
  const reason = input.state === "LOGIN_REQUIRED"
    ? "淘宝登录已失效"
    : "淘宝触发平台验证";
  const challengeAction = input.state === "CHALLENGE_REQUIRED"
    ? ["> 处理：请先在固定 Mac 上完成人工验证"]
    : [];
  const content = [
    "### 淘宝采集已暂停",
    `> 固定采集设备：${safeAgentName(input.agentName)}`,
    `> 原因：${reason}`,
    ...challengeAction,
    `> 发现时间：${formatShanghaiTime(input.openedAt)}`,
    "> 请只在固定 Mac 上恢复一次淘宝登录",
    "> 系统确认登录恢复后会自动续跑"
  ].join("\n");

  return { msgtype: "markdown", markdown: { content } };
}
