import {
  WecomClient,
  WecomDeliveryAmbiguousError,
  type WecomMarkdownSender
} from "../alerts/wecom/wecom.client.ts";
import { buildWecomCollectorSessionMessage } from "../alerts/wecom/wecom-collector-session.ts";
import type { CollectorSessionIncidentRepository } from "./collector-session-incident.repository.ts";

export type CollectorSessionWecomSenderFactory = () => Promise<WecomMarkdownSender | null>;

export function createCollectorSessionWecomSender(
  webhookUrl: string,
  fetcher: typeof fetch = fetch
): WecomMarkdownSender {
  return new WecomClient({ webhookUrl, fetch: fetcher, attempts: 1 });
}

export class CollectorSessionIncidentNotifier {
  private readonly repository: CollectorSessionIncidentRepository;
  private readonly senderFactory: CollectorSessionWecomSenderFactory;
  private readonly isLiveSendingApproved: () => Promise<boolean>;
  private readonly now: () => Date;

  constructor(
    repository: CollectorSessionIncidentRepository,
    senderFactory: CollectorSessionWecomSenderFactory,
    isLiveSendingApproved: () => Promise<boolean> = async () => false,
    now: () => Date = () => new Date()
  ) {
    this.repository = repository;
    this.senderFactory = senderFactory;
    this.isLiveSendingApproved = isLiveSendingApproved;
    this.now = now;
  }

  async notifyPending(agentId: string): Promise<void> {
    if (!await this.isLiveSendingApproved()) return;
    const incident = await this.repository.claimPending(agentId);
    if (!incident) return;

    let sender: WecomMarkdownSender | null;
    try {
      sender = await this.senderFactory();
    } catch {
      sender = null;
    }
    if (!sender) {
      await this.repository.markFailure(incident.id, "WECOM_NOT_CONFIGURED");
      return;
    }

    try {
      const message = buildWecomCollectorSessionMessage({
        agentName: incident.agentName,
        state: incident.state,
        openedAt: incident.openedAt.toISOString()
      });
      await sender.sendMarkdown(message.markdown.content);
    } catch (error) {
      await this.repository.markFailure(
        incident.id,
        error instanceof WecomDeliveryAmbiguousError
          ? "WECOM_DELIVERY_AMBIGUOUS"
          : "WECOM_DELIVERY_FAILED"
      );
      return;
    }

    await this.repository.markNotified(incident.id, this.now());
  }
}
