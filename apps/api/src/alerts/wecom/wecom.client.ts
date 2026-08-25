export interface WecomClientOptions {
  webhookUrl: string;
  fetch?: typeof fetch;
  attempts?: number;
  timeoutMilliseconds?: number;
}
export interface WecomMarkdownSender {
  sendMarkdown(message: string): Promise<void>;
}

function assertWebhookUrl(value: string): string {
  try {
    const url = new URL(value);
    const queryKeys = [...url.searchParams.keys()];
    if (
      url.protocol !== "https:"
      || url.hostname !== "qyapi.weixin.qq.com"
      || url.pathname !== "/cgi-bin/webhook/send"
      || url.username !== ""
      || url.password !== ""
      || url.hash !== ""
      || queryKeys.length !== 1
      || queryKeys[0] !== "key"
      || !url.searchParams.get("key")
    ) {
      throw new TypeError();
    }
    return url.toString();
  } catch {
    throw new TypeError("企业微信 Webhook 地址无效");
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name}必须是正整数`);
  }
  return value;
}

export class WecomClient implements WecomMarkdownSender {
  private readonly webhookUrl: string;
  private readonly fetcher: typeof fetch;
  private readonly attempts: number;
  private readonly timeoutMilliseconds: number;

  constructor(options: WecomClientOptions) {
    this.webhookUrl = assertWebhookUrl(options.webhookUrl);
    this.fetcher = options.fetch ?? fetch;
    this.attempts = positiveInteger(options.attempts ?? 3, "重试次数");
    this.timeoutMilliseconds = positiveInteger(options.timeoutMilliseconds ?? 10_000, "超时时间");
  }

  async sendMarkdown(message: string): Promise<void> {
    const body = JSON.stringify({
      msgtype: "markdown",
      markdown: { content: message }
    });
    for (let attempt = 1; attempt <= this.attempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMilliseconds);
      try {
        const response = await this.fetcher(this.webhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          signal: controller.signal
        });
        const payload = await response.json() as { errcode?: number };
        if (response.ok && payload.errcode === 0) return;
      } catch {
        // Deliberately discard transport details because they may contain the webhook or body.
      } finally {
        clearTimeout(timeout);
      }
    }
    throw new Error("企业微信通知发送失败");
  }
}
