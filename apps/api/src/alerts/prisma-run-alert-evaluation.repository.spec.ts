import assert from "node:assert/strict";
import test from "node:test";

import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import { PrismaRunAlertEvaluationRepository } from "./prisma-run-alert-evaluation.repository.ts";
import { RUN_ALERT_EVALUATION_VERSION } from "./run-alert-evaluation-version.ts";

test("claims and completes only the current evaluation protocol version", async () => {
  const whereClauses: unknown[] = [];
  const transaction = {
    collectionRun: {
      async findFirst(input: { where: unknown }) {
        whereClauses.push(input.where);
        return { id: "current-run" };
      },
      async updateMany(input: { where: unknown }) {
        whereClauses.push(input.where);
        return { count: 1 };
      }
    }
  };
  const prisma = {
    async $transaction<T>(operation: (client: typeof transaction) => Promise<T>): Promise<T> {
      return operation(transaction);
    },
    collectionRun: transaction.collectionRun
  } as unknown as PrismaClient;
  const repository = new PrismaRunAlertEvaluationRepository(prisma);

  const claim = await repository.claimRun(null, new Date("2026-08-28T08:00:00.000Z"));
  assert.ok(claim);
  await repository.markEvaluated(claim, new Date("2026-08-28T08:01:00.000Z"));

  assert.equal(whereClauses.length, 3);
  for (const where of whereClauses) {
    assert.equal(
      Reflect.get(where as object, "alertEvaluationVersion"),
      RUN_ALERT_EVALUATION_VERSION
    );
  }
});
