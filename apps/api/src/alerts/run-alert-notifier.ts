import type { RunAlertSummary } from "../collection/run-alert.service.ts";
import { WecomClient, type WecomMarkdownSender } from "./wecom/wecom.client.ts";
import { buildWecomRunSummary } from "./wecom/wecom-run-summary.ts";

export interface ClaimedRunAlertBatch {
  batchId: string;
  attemptToken: string;
  summary: RunAlertSummary;
  alertIds: string[];
}
export interface RunAlertNotificationRepository {
  claimBatch(summary: RunAlertSummary, attemptedAt: Date): Promise<ClaimedRunAlertBatch | null>;
  markBatchNotified(batch: ClaimedRunAlertBatch, notifiedAt: Date): Promise<void>;
  recordBatchNotificationFailure(
    batch: ClaimedRunAlertBatch,
    message: "WECOM_NOT_CONFIGURED" | "WECOM_DELIVERY_FAILED",
    failedAt: Date
  ): Promise<void>;
}

export type WecomSenderFactory = () => Promise<WecomMarkdownSender | null>;

export class RunAlertNotifier {
  private readonly repository: RunAlertNotificationRepository;
  private readonly senderFactory: WecomSenderFactory;
  private readonly now: () => Date;

  constructor(
    repository: RunAlertNotificationRepository,
    senderFactory: WecomSenderFactory,
    now: () => Date = () => new Date()
  ) {
    this.repository = repository;
    this.senderFactory = senderFactory;
    this.now = now;
  }

  async send(summary: RunAlertSummary): Promise<void> {
    const batch = await this.repository.claimBatch(summary, this.now());
    if (!batch) return;

    let sender: WecomMarkdownSender | null;
    try {
      sender = await this.senderFactory();
    } catch {
      sender = null;
    }
    if (!sender) {
      await this.repository.recordBatchNotificationFailure(
        batch,
        "WECOM_NOT_CONFIGURED",
        this.now()
      );
      return;
    }

    try {
      await sender.sendMarkdown(buildWecomRunSummary(batch.summary));
    } catch {
      await this.repository.recordBatchNotificationFailure(
        batch,
        "WECOM_DELIVERY_FAILED",
        this.now()
      );
      return;
    }

    await this.repository.markBatchNotified(batch, this.now());
  }
}

export function wecomSender(webhookUrl: string): WecomMarkdownSender {
  return new WecomClient({ webhookUrl });
}
