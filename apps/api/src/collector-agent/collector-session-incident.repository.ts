import type { CollectorSessionState } from "../../../../packages/contracts/src/index.ts";
import { Prisma, type PrismaClient } from "../../../../generated/prisma/client.ts";

export const MAX_COLLECTOR_SESSION_NOTIFICATION_ATTEMPTS = 2;
export const COLLECTOR_SESSION_NOTIFICATION_STALE_MILLISECONDS = 5 * 60 * 1_000;
const maximumSerializableAttempts = 5;

export type BlockedCollectorSessionState = Extract<
  CollectorSessionState,
  "LOGIN_REQUIRED" | "CHALLENGE_REQUIRED"
>;

export type CollectorSessionNotificationFailure =
  | "WECOM_NOT_CONFIGURED"
  | "WECOM_DELIVERY_FAILED"
  | "WECOM_DELIVERY_AMBIGUOUS";

export interface CollectorSessionIncidentDelivery {
  id: string;
  agentId: string;
  agentName: string;
  state: BlockedCollectorSessionState;
  openedAt: Date;
}

export interface CollectorSessionIncidentRepository {
  observeBlocked(
    agentId: string,
    state: BlockedCollectorSessionState,
    at: Date
  ): Promise<string | null>;
  observeReady(agentId: string, at: Date): Promise<void>;
  claimPending(agentId: string): Promise<CollectorSessionIncidentDelivery | null>;
  markNotified(id: string, at: Date): Promise<void>;
  markFailure(id: string, code: CollectorSessionNotificationFailure): Promise<void>;
}

interface LockedCollectorSession {
  sessionState: CollectorSessionState;
  sessionObservedAt: Date | null;
}

function isSerializableConflict(error: unknown): boolean {
  return typeof error === "object" && error !== null && Reflect.get(error, "code") === "P2034";
}

function isBlockedState(state: CollectorSessionState): state is BlockedCollectorSessionState {
  return state === "LOGIN_REQUIRED" || state === "CHALLENGE_REQUIRED";
}

async function terminalizeSendingIncident(
  transaction: Prisma.TransactionClient,
  agentId: string
): Promise<void> {
  await transaction.collectorSessionIncident.updateMany({
    where: {
      activeKey: agentId,
      recoveredAt: null,
      notificationState: "SENDING"
    },
    data: {
      notificationState: "AMBIGUOUS",
      lastNotificationError: "WECOM_DELIVERY_AMBIGUOUS"
    }
  });
}

async function closeActiveIncident(
  transaction: Prisma.TransactionClient,
  agentId: string,
  recoveredAt: Date
): Promise<void> {
  await transaction.collectorSessionIncident.updateMany({
    where: {
      activeKey: agentId,
      recoveredAt: null,
      openedAt: { lte: recoveredAt }
    },
    data: { activeKey: null, recoveredAt }
  });
}

export async function reconcileCollectorSessionIncident(
  transaction: Prisma.TransactionClient,
  agentId: string,
  previousState: CollectorSessionState,
  state: CollectorSessionState,
  observedAt: Date
): Promise<string | null> {
  if (state === "READY") {
    await terminalizeSendingIncident(transaction, agentId);
    await closeActiveIncident(transaction, agentId, observedAt);
    return null;
  }
  if (!isBlockedState(state)) return null;

  if (!isBlockedState(previousState)) {
    await terminalizeSendingIncident(transaction, agentId);
    await closeActiveIncident(transaction, agentId, observedAt);
  }
  const incident = await transaction.collectorSessionIncident.upsert({
    where: { activeKey: agentId },
    create: {
      collectorAgentId: agentId,
      state,
      activeKey: agentId,
      openedAt: observedAt
    },
    update: { state },
    select: { id: true }
  });
  return incident.id;
}

export class PrismaCollectorSessionIncidentRepository implements CollectorSessionIncidentRepository {
  private readonly prisma: PrismaClient;
  private readonly now: () => Date;

  constructor(prisma: PrismaClient, now: () => Date = () => new Date()) {
    this.prisma = prisma;
    this.now = now;
  }

  async observeBlocked(
    agentId: string,
    state: BlockedCollectorSessionState,
    at: Date
  ): Promise<string | null> {
    for (let attempt = 0; attempt < maximumSerializableAttempts; attempt += 1) {
      try {
        return await this.prisma.$transaction(async (transaction) => {
          const [agent] = await transaction.$queryRaw<LockedCollectorSession[]>(Prisma.sql`
            SELECT "sessionState"::text AS "sessionState", "sessionObservedAt"
            FROM "CollectorAgent"
            WHERE "id" = ${agentId}
            FOR UPDATE
          `);
          if (
            !agent
            || agent.sessionState !== state
            || !agent.sessionObservedAt
            || agent.sessionObservedAt.getTime() !== at.getTime()
          ) return null;

          return reconcileCollectorSessionIncident(transaction, agentId, state, state, at);
        }, { isolationLevel: "Serializable" });
      } catch (error) {
        if (!isSerializableConflict(error) || attempt === maximumSerializableAttempts - 1) throw error;
      }
    }
    return null;
  }

  async observeReady(agentId: string, at: Date): Promise<void> {
    for (let attempt = 0; attempt < maximumSerializableAttempts; attempt += 1) {
      try {
        await this.prisma.$transaction(async (transaction) => {
          const [agent] = await transaction.$queryRaw<LockedCollectorSession[]>(Prisma.sql`
            SELECT "sessionState"::text AS "sessionState", "sessionObservedAt"
            FROM "CollectorAgent"
            WHERE "id" = ${agentId}
            FOR UPDATE
          `);
          if (
            !agent
            || agent.sessionState !== "READY"
            || !agent.sessionObservedAt
            || agent.sessionObservedAt.getTime() !== at.getTime()
          ) return;
          await reconcileCollectorSessionIncident(transaction, agentId, "READY", "READY", at);
        }, { isolationLevel: "Serializable" });
        return;
      } catch (error) {
        if (!isSerializableConflict(error) || attempt === maximumSerializableAttempts - 1) throw error;
      }
    }
  }

  async claimPending(agentId: string): Promise<CollectorSessionIncidentDelivery | null> {
    const incident = await this.prisma.collectorSessionIncident.findUnique({
      where: { activeKey: agentId },
      select: {
        id: true,
        collectorAgentId: true,
        state: true,
        activeKey: true,
        openedAt: true,
        recoveredAt: true,
        notificationState: true,
        notificationAttempts: true,
        notificationStartedAt: true,
        collectorAgent: { select: { name: true } }
      }
    });
    if (incident?.notificationState === "SENDING") {
      const staleBefore = new Date(
        this.now().getTime() - COLLECTOR_SESSION_NOTIFICATION_STALE_MILLISECONDS
      );
      if (
        incident.notificationStartedAt === null
        || incident.notificationStartedAt.getTime() <= staleBefore.getTime()
      ) {
        await this.prisma.collectorSessionIncident.updateMany({
          where: {
            id: incident.id,
            activeKey: agentId,
            recoveredAt: null,
            notificationState: "SENDING",
            OR: [
              { notificationStartedAt: null },
              { notificationStartedAt: { lte: staleBefore } }
            ]
          },
          data: {
            notificationState: "AMBIGUOUS",
            lastNotificationError: "WECOM_DELIVERY_AMBIGUOUS"
          }
        });
      }
      return null;
    }
    if (
      !incident
      || incident.activeKey !== agentId
      || incident.recoveredAt !== null
      || incident.notificationState !== "PENDING"
      || incident.notificationAttempts >= MAX_COLLECTOR_SESSION_NOTIFICATION_ATTEMPTS
      || (incident.state !== "LOGIN_REQUIRED" && incident.state !== "CHALLENGE_REQUIRED")
    ) return null;

    const notificationStartedAt = this.now();
    const claimed = await this.prisma.collectorSessionIncident.updateMany({
      where: {
        id: incident.id,
        activeKey: agentId,
        recoveredAt: null,
        notificationState: "PENDING",
        notificationAttempts: { lt: MAX_COLLECTOR_SESSION_NOTIFICATION_ATTEMPTS }
      },
      data: {
        notificationState: "SENDING",
        notificationAttempts: { increment: 1 },
        notificationStartedAt,
        lastNotificationError: null
      }
    });
    if (claimed.count !== 1) return null;

    return {
      id: incident.id,
      agentId: incident.collectorAgentId,
      agentName: incident.collectorAgent.name,
      state: incident.state,
      openedAt: incident.openedAt
    };
  }

  async markNotified(id: string, at: Date): Promise<void> {
    await this.prisma.collectorSessionIncident.updateMany({
      where: { id, notificationState: "SENDING" },
      data: {
        notificationState: "NOTIFIED",
        notifiedAt: at,
        lastNotificationError: null
      }
    });
  }

  async markFailure(id: string, code: CollectorSessionNotificationFailure): Promise<void> {
    const incident = await this.prisma.collectorSessionIncident.findUnique({
      where: { id },
      select: { notificationState: true, notificationAttempts: true }
    });
    if (!incident || incident.notificationState !== "SENDING") return;

    const notificationState = code === "WECOM_DELIVERY_AMBIGUOUS"
      ? "AMBIGUOUS"
      : incident.notificationAttempts >= MAX_COLLECTOR_SESSION_NOTIFICATION_ATTEMPTS
        ? "FAILED"
        : "PENDING";
    await this.prisma.collectorSessionIncident.updateMany({
      where: { id, notificationState: "SENDING" },
      data: {
        notificationState,
        ...(notificationState === "PENDING" ? { notificationStartedAt: null } : {}),
        lastNotificationError: code
      }
    });
  }
}
