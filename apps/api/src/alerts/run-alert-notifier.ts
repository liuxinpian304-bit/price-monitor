import type { RunAlertSummary } from "../collection/run-alert.service.ts";
import {
  WecomClient,
  WecomDeliveryAmbiguousError,
  type WecomMarkdownSender
} from "./wecom/wecom.client.ts";
import { buildWecomRunSummary } from "./wecom/wecom-run-summary.ts";

export interface ClaimedRunAlertBatch {
  batchId: string;
  attemptToken: string;
  summary: RunAlertSummary;
  alertIds: string[];
}
export interface StoredRunAlertNotificationBatch {
  batchId: string;
  runId: string;
  state: "PENDING" | "SENDING" | "NOTIFIED" | "AMBIGUOUS" | "FAILED";
  summary: RunAlertSummary;
}
export interface RunAlertNotificationRepository {
  getBatch(runId: string): Promise<StoredRunAlertNotificationBatch | null>;
  claimBatch(runId: string, attemptedAt: Date): Promise<ClaimedRunAlertBatch | null>;
  markBatchNotified(batch: ClaimedRunAlertBatch, notifiedAt: Date): Promise<void>;
  recordBatchNotificationFailure(
    batch: ClaimedRunAlertBatch,
    message: "WECOM_NOT_CONFIGURED" | "WECOM_DELIVERY_FAILED",
    failedAt: Date
  ): Promise<void>;
  recordBatchNotificationAmbiguous(
    batch: ClaimedRunAlertBatch,
    failedAt: Date
  ): Promise<void>;
  listRetryableSummaries(attemptedAt: Date, limit: number): Promise<RunAlertSummary[]>;
}

export type WecomSenderFactory = () => Promise<WecomMarkdownSender | null>;

export class RunAlertNotifier {
  private readonly repository: RunAlertNotificationRepository;
  private readonly senderFactory: WecomSenderFactory;
  private readonly isLiveSendingApproved: () => Promise<boolean>;
  private readonly now: () => Date;

  constructor(
    repository: RunAlertNotificationRepository,
    senderFactory: WecomSenderFactory,
    isLiveSendingApproved: () => Promise<boolean> = async () => true,
    now: () => Date = () => new Date()
  ) {
    this.repository = repository;
    this.senderFactory = senderFactory;
    this.isLiveSendingApproved = isLiveSendingApproved;
    this.now = now;
  }

  async send(summary: RunAlertSummary): Promise<void> {
    if (!await this.isLiveSendingApproved()) return;
    const batch = await this.repository.claimBatch(summary.runId, this.now());
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
    } catch (error) {
      if (error instanceof WecomDeliveryAmbiguousError) {
        await this.repository.recordBatchNotificationAmbiguous(batch, this.now());
        return;
      }
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
