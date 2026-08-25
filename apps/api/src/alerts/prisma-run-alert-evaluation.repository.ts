import { randomUUID } from "node:crypto";

import { type PrismaClient } from "../../../../generated/prisma/client.ts";
import type {
  ClaimedRunAlertEvaluation,
  RunAlertEvaluationRepository
} from "./run-alert-reconciler.ts";

const CLAIM_LEASE_MILLISECONDS = 5 * 60 * 1_000;
const MAX_EVALUATION_ATTEMPTS = 3;

export class RunAlertEvaluationPersistenceError extends Error {
  constructor() {
    super("Run alert evaluation persistence failed");
    this.name = "RunAlertEvaluationPersistenceError";
  }
}

export class PrismaRunAlertEvaluationRepository implements RunAlertEvaluationRepository {
  private readonly prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  async claimRun(
    runId: string | null,
    attemptedAt: Date
  ): Promise<ClaimedRunAlertEvaluation | null> {
    const staleBefore = new Date(attemptedAt.getTime() - CLAIM_LEASE_MILLISECONDS);
    return this.prisma.$transaction(async (transaction) => {
      const candidate = await transaction.collectionRun.findFirst({
        where: {
          ...(runId ? { id: runId } : {}),
          desktopReportDigest: { not: null },
          alertEvaluatedAt: null,
          alertEvaluationAttempts: { lt: MAX_EVALUATION_ATTEMPTS },
          OR: [
            { alertEvaluationLastAttemptAt: null },
            { alertEvaluationLastAttemptAt: { lt: attemptedAt } }
          ],
          AND: [{
            OR: [
              { alertEvaluationToken: null },
              { alertEvaluationStartedAt: { lte: staleBefore } }
            ]
          }]
        },
        orderBy: [{ finishedAt: "asc" }, { createdAt: "asc" }],
        select: { id: true }
      });
      if (!candidate) return null;

      const attemptToken = randomUUID();
      const claimed = await transaction.collectionRun.updateMany({
        where: {
          id: candidate.id,
          alertEvaluatedAt: null,
          alertEvaluationAttempts: { lt: MAX_EVALUATION_ATTEMPTS },
          OR: [
            { alertEvaluationToken: null },
            { alertEvaluationStartedAt: { lte: staleBefore } }
          ]
        },
        data: {
          alertEvaluationToken: attemptToken,
          alertEvaluationStartedAt: attemptedAt,
          alertEvaluationLastAttemptAt: attemptedAt,
          alertEvaluationAttempts: { increment: 1 },
          alertEvaluationError: null
        }
      });
      return claimed.count === 1 ? { runId: candidate.id, attemptToken } : null;
    });
  }

  async markEvaluated(claim: ClaimedRunAlertEvaluation, completedAt: Date): Promise<void> {
    await this.complete(claim, {
      alertEvaluationToken: null,
      alertEvaluationStartedAt: null,
      alertEvaluatedAt: completedAt,
      alertEvaluationError: null
    });
  }

  async recordEvaluationFailure(claim: ClaimedRunAlertEvaluation): Promise<void> {
    await this.complete(claim, {
      alertEvaluationToken: null,
      alertEvaluationStartedAt: null,
      alertEvaluationError: "RUN_ALERT_EVALUATION_FAILED"
    });
  }

  private async complete(
    claim: ClaimedRunAlertEvaluation,
    data: {
      alertEvaluationToken: null;
      alertEvaluationStartedAt: null;
      alertEvaluatedAt?: Date;
      alertEvaluationError: string | null;
    }
  ): Promise<void> {
    const completed = await this.prisma.collectionRun.updateMany({
      where: {
        id: claim.runId,
        alertEvaluationToken: claim.attemptToken,
        alertEvaluatedAt: null
      },
      data
    });
    if (completed.count !== 1) throw new RunAlertEvaluationPersistenceError();
  }
}
