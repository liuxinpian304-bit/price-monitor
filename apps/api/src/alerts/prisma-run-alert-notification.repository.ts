import { randomUUID } from "node:crypto";

import {
  Prisma,
  type PrismaClient,
  type RunAlertNotificationBatch
} from "../../../../generated/prisma/client.ts";
import type { RunAlertSummary } from "../collection/run-alert.service.ts";
import { PrismaAlertRepository } from "./prisma-alert.repository.ts";
import type {
  ClaimedRunAlertBatch,
  RunAlertNotificationRepository,
  StoredRunAlertNotificationBatch
} from "./run-alert-notifier.ts";
import {
  runAlertSummaryFromJson,
  RunAlertNotificationPersistenceError
} from "./run-alert-summary.persistence.ts";

const CLAIM_LEASE_MILLISECONDS = 5 * 60 * 1_000;
const MAX_BATCH_DELIVERY_ATTEMPTS = 2;

function sameIds(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

export class PrismaRunAlertNotificationRepository implements RunAlertNotificationRepository {
  private readonly prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  async getBatch(runId: string): Promise<StoredRunAlertNotificationBatch | null> {
    const batch = await this.prisma.runAlertNotificationBatch.findUnique({
      where: { collectionRunId: runId },
      select: { id: true, state: true, summary: true }
    });
    return batch ? {
      batchId: batch.id,
      runId,
      state: batch.state,
      summary: runAlertSummaryFromJson(batch.summary)
    } : null;
  }

  async claimBatch(runId: string, attemptedAt: Date): Promise<ClaimedRunAlertBatch | null> {
    return this.prisma.$transaction(async (transaction) => {
      const run = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id"
        FROM "CollectionRun"
        WHERE "id" = ${runId}
        FOR UPDATE
      `);
      if (run.length !== 1) throw new RunAlertNotificationPersistenceError();

      let batch = await transaction.runAlertNotificationBatch.findUnique({
        where: { collectionRunId: runId }
      });
      if (!batch) return null;
      const lockedBatch = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id"
        FROM "RunAlertNotificationBatch"
        WHERE "id" = ${batch.id}
        FOR UPDATE
      `);
      if (lockedBatch.length !== 1) throw new RunAlertNotificationPersistenceError();
      batch = await transaction.runAlertNotificationBatch.findUniqueOrThrow({
        where: { id: batch.id }
      });

      if (
        batch.state === "NOTIFIED"
        || batch.state === "AMBIGUOUS"
        || batch.state === "FAILED"
      ) return null;
      if (batch.state === "SENDING") {
        if (
          batch.attemptStartedAt
          && batch.attemptStartedAt.getTime() > attemptedAt.getTime() - CLAIM_LEASE_MILLISECONDS
        ) return null;
        await new PrismaAlertRepository(transaction).recordBatchNotificationFailure(
          batch.alertIds,
          "WECOM_DELIVERY_AMBIGUOUS"
        );
        await transaction.runAlertNotificationBatch.update({
          where: { id: batch.id },
          data: {
            state: "AMBIGUOUS",
            attemptToken: null,
            attemptStartedAt: null,
            lastNotificationError: "WECOM_DELIVERY_AMBIGUOUS"
          }
        });
        return null;
      }
      if (batch.notificationAttempts >= MAX_BATCH_DELIVERY_ATTEMPTS) {
        await transaction.runAlertNotificationBatch.update({
          where: { id: batch.id },
          data: {
            state: "FAILED",
            attemptToken: null,
            attemptStartedAt: null
          }
        });
        return null;
      }

      const attemptToken = randomUUID();
      const claimed = await transaction.runAlertNotificationBatch.update({
        where: { id: batch.id },
        data: {
          state: "SENDING",
          attemptToken,
          attemptStartedAt: attemptedAt,
          notificationAttempts: { increment: 1 },
          lastNotificationAttemptAt: attemptedAt
        }
      });
      return {
        batchId: claimed.id,
        attemptToken,
        summary: runAlertSummaryFromJson(claimed.summary),
        alertIds: claimed.alertIds
      };
    }, { isolationLevel: "ReadCommitted", maxWait: 10_000, timeout: 30_000 });
  }

  async markBatchNotified(batch: ClaimedRunAlertBatch, notifiedAt: Date): Promise<void> {
    await this.completeAttempt(batch, async (transaction) => {
      await new PrismaAlertRepository(transaction).markBatchNotified(batch.alertIds, notifiedAt);
      await transaction.runAlertNotificationBatch.update({
        where: { id: batch.batchId },
        data: {
          state: "NOTIFIED",
          attemptToken: null,
          attemptStartedAt: null,
          lastNotificationError: null,
          lastNotificationAttemptAt: notifiedAt,
          notifiedAt
        }
      });
    });
  }

  async recordBatchNotificationFailure(
    batch: ClaimedRunAlertBatch,
    message: "WECOM_NOT_CONFIGURED" | "WECOM_DELIVERY_FAILED",
    failedAt: Date
  ): Promise<void> {
    await this.completeAttempt(batch, async (transaction, stored) => {
      await new PrismaAlertRepository(transaction).recordBatchNotificationFailure(
        batch.alertIds,
        message
      );
      await transaction.runAlertNotificationBatch.update({
        where: { id: batch.batchId },
        data: {
          state: stored.notificationAttempts >= MAX_BATCH_DELIVERY_ATTEMPTS
            ? "FAILED"
            : "PENDING",
          attemptToken: null,
          attemptStartedAt: null,
          lastNotificationError: message,
          lastNotificationAttemptAt: failedAt
        }
      });
    });
  }

  async recordBatchNotificationAmbiguous(
    batch: ClaimedRunAlertBatch,
    failedAt: Date
  ): Promise<void> {
    await this.completeAttempt(batch, async (transaction) => {
      await new PrismaAlertRepository(transaction).recordBatchNotificationFailure(
        batch.alertIds,
        "WECOM_DELIVERY_AMBIGUOUS"
      );
      await transaction.runAlertNotificationBatch.update({
        where: { id: batch.batchId },
        data: {
          state: "AMBIGUOUS",
          attemptToken: null,
          attemptStartedAt: null,
          lastNotificationError: "WECOM_DELIVERY_AMBIGUOUS",
          lastNotificationAttemptAt: failedAt
        }
      });
    });
  }

  async listRetryableSummaries(attemptedAt: Date, limit: number): Promise<RunAlertSummary[]> {
    const staleBefore = new Date(attemptedAt.getTime() - CLAIM_LEASE_MILLISECONDS);
    await this.markAbandonedAttemptsAmbiguous(staleBefore, limit);
    const batches = await this.prisma.runAlertNotificationBatch.findMany({
      where: {
        notificationAttempts: { lt: MAX_BATCH_DELIVERY_ATTEMPTS },
        state: "PENDING"
      },
      orderBy: [{ createdAt: "asc" }],
      take: limit,
      select: { summary: true }
    });
    return batches.map((batch) => runAlertSummaryFromJson(batch.summary));
  }

  private async markAbandonedAttemptsAmbiguous(staleBefore: Date, limit: number): Promise<void> {
    const abandoned = await this.prisma.runAlertNotificationBatch.findMany({
      where: { state: "SENDING", attemptStartedAt: { lte: staleBefore } },
      orderBy: [{ attemptStartedAt: "asc" }, { createdAt: "asc" }],
      take: limit,
      select: { id: true }
    });
    for (const batch of abandoned) {
      await this.prisma.$transaction(async (transaction) => {
        const locked = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT "id"
          FROM "RunAlertNotificationBatch"
          WHERE "id" = ${batch.id}
          FOR UPDATE
        `);
        if (locked.length !== 1) throw new RunAlertNotificationPersistenceError();
        const stored = await transaction.runAlertNotificationBatch.findUniqueOrThrow({
          where: { id: batch.id }
        });
        if (
          stored.state !== "SENDING"
          || stored.attemptStartedAt === null
          || stored.attemptStartedAt.getTime() > staleBefore.getTime()
        ) return;

        await new PrismaAlertRepository(transaction).recordBatchNotificationFailure(
          stored.alertIds,
          "WECOM_DELIVERY_AMBIGUOUS"
        );
        await transaction.runAlertNotificationBatch.update({
          where: { id: stored.id },
          data: {
            state: "AMBIGUOUS",
            attemptToken: null,
            attemptStartedAt: null,
            lastNotificationError: "WECOM_DELIVERY_AMBIGUOUS"
          }
        });
      }, { isolationLevel: "ReadCommitted", maxWait: 10_000, timeout: 30_000 });
    }
  }

  private async completeAttempt(
    batch: ClaimedRunAlertBatch,
    operation: (
      transaction: Prisma.TransactionClient,
      stored: RunAlertNotificationBatch
    ) => Promise<void>
  ): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      const locked = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id"
        FROM "RunAlertNotificationBatch"
        WHERE "id" = ${batch.batchId}
        FOR UPDATE
      `);
      if (locked.length !== 1) throw new RunAlertNotificationPersistenceError();
      const stored = await transaction.runAlertNotificationBatch.findUniqueOrThrow({
        where: { id: batch.batchId }
      });
      if (
        stored.state !== "SENDING"
        || stored.attemptToken !== batch.attemptToken
        || !sameIds(stored.alertIds, batch.alertIds)
      ) {
        throw new RunAlertNotificationPersistenceError();
      }
      await operation(transaction, stored);
    }, { isolationLevel: "ReadCommitted", maxWait: 10_000, timeout: 30_000 });
  }
}
