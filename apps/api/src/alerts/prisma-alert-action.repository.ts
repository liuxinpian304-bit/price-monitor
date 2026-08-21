import type { PrismaClient } from "../../../../generated/prisma/client.ts";

import type {
  AlertActionRecord,
  AlertActionRepository,
  AlertStateRecord,
  NewAlertAction
} from "./alert-action.service.ts";

export class PrismaAlertActionRepository implements AlertActionRepository {
  private readonly prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  async listAlerts(): Promise<AlertStateRecord[]> {
    return this.prisma.priceAlert.findMany({
      select: { id: true, status: true },
      orderBy: { createdAt: "desc" }
    });
  }

  async findAlertById(id: string): Promise<AlertStateRecord | null> {
    return this.prisma.priceAlert.findUnique({
      where: { id },
      select: { id: true, status: true }
    });
  }

  async listActions(alertId: string): Promise<AlertActionRecord[]> {
    const actions = await this.prisma.alertAction.findMany({
      where: { alertId },
      orderBy: { createdAt: "asc" }
    });
    return actions.map((action) => ({
      id: action.id,
      alertId: action.alertId,
      actorId: action.actorId,
      status: action.status,
      ...(action.reasonCode ? { reasonCode: action.reasonCode } : {}),
      ...(action.note ? { note: action.note } : {}),
      createdAt: action.createdAt
    }));
  }

  async applyAction(alertId: string, action: NewAlertAction): Promise<AlertStateRecord> {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.alertAction.create({
        data: {
          alertId,
          actorId: action.actorId,
          status: action.status,
          reasonCode: action.reasonCode ?? null,
          note: action.note ?? null
        }
      });
      return transaction.priceAlert.update({
        where: { id: alertId },
        data: { status: action.status },
        select: { id: true, status: true }
      });
    });
  }
}
