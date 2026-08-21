import type { AlertStatus } from "../data/demo-data.ts";

const labels: Record<AlertStatus, string> = {
  PENDING: "待处理",
  PRICE_CHANGED: "已改价",
  NO_FOLLOW: "不跟价",
  FALSE_POSITIVE: "误报",
  WATCHING: "继续观察"
};

export function StatusText({ status }: { status: AlertStatus }) {
  return <span className={`status-text status-${status.toLocaleLowerCase()}`}>{labels[status]}</span>;
}
