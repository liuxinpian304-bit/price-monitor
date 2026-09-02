import { createHash } from "node:crypto";

import type { RunAlertSummary } from "../collection/run-alert.service.ts";
import {
  RoleForbiddenError,
  SettingsService,
  type UserRole
} from "../settings/settings.service.ts";
import {
  RunAlertNotifier,
  type RunAlertNotificationRepository,
  type StoredRunAlertNotificationBatch
} from "./run-alert-notifier.ts";
import { buildWecomRunSummary } from "./wecom/wecom-run-summary.ts";

export class RunAlertNotificationApprovalValidationError extends Error {}
export class RunAlertNotificationBatchNotFoundError extends Error {}

export interface RunAlertNotificationPreview {
  runId: string;
  state: StoredRunAlertNotificationBatch["state"];
  markdown: string;
  previewDigest: string;
  liveSendingApproved: boolean;
}

export interface RunAlertNotificationApprovalInput {
  runId: string;
  previewDigest: string;
  confirmation: string;
}

interface CurrentPreview extends RunAlertNotificationPreview {
  summary: RunAlertSummary;
}

function markdownDigest(markdown: string): string {
  return `sha256:${createHash("sha256").update(markdown).digest("hex")}`;
}

export class RunAlertNotificationApprovalService {
  private readonly repository: RunAlertNotificationRepository;
  private readonly settings: SettingsService;
  private readonly notifier: RunAlertNotifier;

  constructor(
    repository: RunAlertNotificationRepository,
    settings: SettingsService,
    notifier: RunAlertNotifier
  ) {
    this.repository = repository;
    this.settings = settings;
    this.notifier = notifier;
  }

  async preview(runId: string): Promise<RunAlertNotificationPreview> {
    const { summary: _summary, ...preview } = await this.currentPreview(runId);
    return preview;
  }

  async approve(
    input: RunAlertNotificationApprovalInput,
    actorId: string,
    role: UserRole
  ): Promise<void> {
    if (role !== "ADMIN") throw new RoleForbiddenError("只有管理员可以确认企业微信发送");
    if (
      typeof input.runId !== "string"
      || input.runId.trim() === ""
      || input.confirmation !== "SEND_TO_WECOM"
      || typeof input.previewDigest !== "string"
    ) {
      throw new RunAlertNotificationApprovalValidationError("企业微信确认文本无效");
    }

    const current = await this.currentPreview(input.runId);
    if (input.previewDigest !== current.previewDigest) {
      throw new RunAlertNotificationApprovalValidationError("企业微信预览已变化，请刷新后重新确认");
    }
    if (!current.liveSendingApproved && current.state !== "PENDING") {
      throw new RunAlertNotificationApprovalValidationError("首次企业微信发送只能确认待发送批次");
    }

    await this.settings.approveWecomLiveSending({
      previewRunId: current.runId,
      previewDigest: current.previewDigest
    }, actorId, role);
    await this.notifier.send(current.summary);
  }

  private async currentPreview(runId: string): Promise<CurrentPreview> {
    const batch = await this.repository.getBatch(runId);
    if (!batch) {
      throw new RunAlertNotificationBatchNotFoundError("企业微信通知批次不存在");
    }
    const markdown = buildWecomRunSummary(batch.summary);
    return {
      runId,
      state: batch.state,
      markdown,
      previewDigest: markdownDigest(markdown),
      liveSendingApproved: await this.settings.isWecomLiveSendingApproved(),
      summary: batch.summary
    };
  }
}
