import type { PriceAlertNotifier, PriceAlertRecord } from "../alert.service.ts";
import { buildWecomPriceAlertMessage } from "./wecom.message.ts";

export interface WecomClientOptions {
  webhookUrl: string;
  fetch?: typeof fetch;
  attempts?: number;
  timeoutMilliseconds?: number;
}

function assertWebhookUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "qyapi.weixin.qq.com" ||
    url.pathname !== "/cgi-bin/webhook/send" ||
    !url.searchParams.get("key")
  ) {
    throw new TypeError("企业微信 Webhook 地址无效");
  }
  return value;
}

export class WecomClient implements PriceAlertNotifier {
  private readonly webhookUrl: string;
  private readonly fetcher: typeof fetch;
  private readonly attempts: number;
  private readonly timeoutMilliseconds: number;

  constructor(options: WecomClientOptions) {
    this.webhookUrl = assertWebhookUrl(options.webhookUrl);
    this.fetcher = options.fetch ?? fetch;
    this.attempts = options.attempts ?? 3;
    this.timeoutMilliseconds = options.timeoutMilliseconds ?? 10_000;
  }

  async sendPriceAlert(alert: PriceAlertRecord): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.attempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMilliseconds);
      try {
        const response = await this.fetcher(this.webhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(buildWecomPriceAlertMessage(alert)),
          signal: controller.signal
        });
        const payload = await response.json() as { errcode?: number; errmsg?: string };
        if (!response.ok || payload.errcode !== 0) {
          throw new Error(payload.errmsg || `企业微信返回 HTTP ${response.status}`);
        }
        return;
      } catch (error) {
        lastError = error;
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastError instanceof Error ? lastError : new Error("企业微信通知发送失败");
  }
}
