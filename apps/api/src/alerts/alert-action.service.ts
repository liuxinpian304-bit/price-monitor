import type { AlertStatus } from "../../../../packages/contracts/src/index.ts";
import { AuditService } from "../audit/audit.service.ts";
import {
  alertActionSchema,
  type AlertActionInput
} from "./alert-action.dto.ts";

export interface AlertStateRecord {
  id: string;
  status: AlertStatus;
}

export interface AlertActionRecord {
  id: string;
  alertId: string;
  actorId: string;
  status: AlertStatus;
  reasonCode?: string;
  note?: string;
  createdAt: Date;
}

export interface NewAlertAction {
  actorId: string;
  status: AlertStatus;
  reasonCode?: string;
  note?: string;
}

export interface AlertActionRepository {
  listAlerts(): Promise<AlertStateRecord[]>;
  findAlertById(id: string): Promise<AlertStateRecord | null>;
  listActions(alertId: string): Promise<AlertActionRecord[]>;
  applyAction(alertId: string, action: NewAlertAction): Promise<AlertStateRecord>;
}

export class AlertActionValidationError extends Error {}
export class AlertActionConflictError extends Error {}
export class AlertActionNotFoundError extends Error {}

const ALLOWED_TRANSITIONS: Record<AlertStatus, readonly AlertStatus[]> = {
  PENDING: ["PRICE_CHANGED", "NO_FOLLOW", "FALSE_POSITIVE", "WATCHING"],
  WATCHING: ["PENDING", "PRICE_CHANGED", "NO_FOLLOW", "FALSE_POSITIVE"],
  PRICE_CHANGED: [],
  NO_FOLLOW: [],
  FALSE_POSITIVE: []
};

export class AlertActionService {
  private readonly repository: AlertActionRepository;
  private readonly audit: AuditService;

  constructor(repository: AlertActionRepository, audit: AuditService) {
    this.repository = repository;
    this.audit = audit;
  }

  async listAlerts(): Promise<AlertStateRecord[]> {
    return this.repository.listAlerts();
  }

  async getAlert(id: string): Promise<AlertStateRecord> {
    return this.requireAlert(id);
  }

  async listActions(alertId: string): Promise<AlertActionRecord[]> {
    await this.requireAlert(alertId);
    return this.repository.listActions(alertId);
  }

  async applyAction(
    alertId: string,
    input: AlertActionInput,
    actorId: string
  ): Promise<AlertStateRecord> {
    const parsed = alertActionSchema.safeParse(input);
    if (!parsed.success) {
      throw new AlertActionValidationError(parsed.error.issues.map((issue) => issue.message).join("；"));
    }

    const existing = await this.requireAlert(alertId);
    if (!ALLOWED_TRANSITIONS[existing.status].includes(parsed.data.status)) {
      throw new AlertActionConflictError(`预警状态不能从 ${existing.status} 变更为 ${parsed.data.status}`);
    }

    const updated = await this.repository.applyAction(alertId, {
      actorId,
      status: parsed.data.status,
      ...(parsed.data.reasonCode ? { reasonCode: parsed.data.reasonCode } : {}),
      ...(parsed.data.note ? { note: parsed.data.note } : {})
    });
    await this.audit.record({
      actorId,
      action: "alert.status.changed",
      entityType: "PriceAlert",
      entityId: alertId,
      before: { status: existing.status },
      after: { status: updated.status }
    });
    return updated;
  }

  private async requireAlert(id: string): Promise<AlertStateRecord> {
    const alert = await this.repository.findAlertById(id);
    if (!alert) {
      throw new AlertActionNotFoundError(`预警“${id}”不存在`);
    }
    return alert;
  }
}
