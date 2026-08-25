import { randomUUID } from "node:crypto";
import { z } from "zod";

import {
  Prisma,
  type PrismaClient,
  type RunAlertNotificationBatch
} from "../../../../generated/prisma/client.ts";
import type { RunAlertSummary } from "../collection/run-alert.service.ts";
import { PrismaAlertRepository } from "./prisma-alert.repository.ts";
import type {
  ClaimedRunAlertBatch,
  RunAlertNotificationRepository
} from "./run-alert-notifier.ts";

const CLAIM_LEASE_MILLISECONDS = 5 * 60 * 1_000;
const MAX_BATCH_DELIVERY_ATTEMPTS = 2;
const moneySchema = z.number().int().nonnegative().safe();
const nonNegativeIntegerSchema = z.number().int().nonnegative().safe();
const summarySchema = z.object({
  runId: z.string().min(1),
  monitoredModelId: z.string().min(1),
  brand: z.string(),
  standardModel: z.string(),
  comparisonType: z.enum(["BARE", "BUNDLE"]),
  owner: z.string(),
  completedAt: z.iso.datetime({ offset: true }),
  checkedItemCount: nonNegativeIntegerSchema,
  searchLimit: nonNegativeIntegerSchema,
  skuCount: nonNegativeIntegerSchema,
  issueCount: nonNegativeIntegerSchema,
  reportUrl: z.string().max(2_048),
  baseline: z.object({
    snapshotId: z.string().min(1),
    skuId: z.string().min(1),
    skuText: z.string(),
    activityPriceFen: moneySchema,
    publicDiscountFen: moneySchema,
    payableFen: moneySchema
  }).strict().nullable(),
  systemIssue: z.enum(["OWN_BASELINE_MISSING", "OWN_BASELINE_AMBIGUOUS"]).nullable(),
  alerts: z.array(z.object({
    alertId: z.string().min(1),
    severity: z.enum(["CONFIRMED_LOW", "MANUAL_REVIEW"]),
    snapshotId: z.string().min(1),
    rank: z.number().int().positive().safe().nullable(),
    shopName: z.string(),
    title: z.string(),
    skuText: z.string(),
    activityPriceFen: moneySchema,
    publicDiscountFen: moneySchema,
    payableFen: moneySchema,
    differenceFen: moneySchema,
    url: z.string(),
    reasons: z.array(z.string())
  }).strict())
}).strict();

export class RunAlertNotificationPersistenceError extends Error {
  constructor() {
    super("Run alert notification persistence failed");
    this.name = "RunAlertNotificationPersistenceError";
  }
}
function toJson(summary: RunAlertSummary): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(summary)) as Prisma.InputJsonValue;
}

function fromJson(value: Prisma.JsonValue): RunAlertSummary {
  const parsed = summarySchema.safeParse(value);
  if (!parsed.success) throw new RunAlertNotificationPersistenceError();
  return {
    ...parsed.data,
    completedAt: new Date(parsed.data.completedAt)
  };
}

function sameIds(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

export class PrismaRunAlertNotificationRepository implements RunAlertNotificationRepository {
  private readonly prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  async claimBatch(summary: RunAlertSummary, attemptedAt: Date): Promise<ClaimedRunAlertBatch | null> {
    return this.prisma.$transaction(async (transaction) => {
      const run = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id"
        FROM "CollectionRun"
        WHERE "id" = ${summary.runId}
        FOR UPDATE
      `);
      if (run.length !== 1) throw new RunAlertNotificationPersistenceError();

      let batch = await transaction.runAlertNotificationBatch.findUnique({
        where: { collectionRunId: summary.runId }
      });
      if (!batch) {
        if (summary.alerts.length === 0 && summary.systemIssue === null) return null;
        await transaction.runAlertNotificationBatch.create({
          data: {
            collectionRunId: summary.runId,
            summary: toJson(summary),
            alertIds: summary.alerts.map((alert) => alert.alertId)
          }
        });
        batch = await transaction.runAlertNotificationBatch.findUniqueOrThrow({
          where: { collectionRunId: summary.runId }
        });
      }
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
        summary: fromJson(claimed.summary),
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
    return batches.map((batch) => fromJson(batch.summary));
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
