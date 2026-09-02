import assert from "node:assert/strict";
import test from "node:test";

import type { RunAlertSummary } from "../collection/run-alert.service.ts";
import {
  RunAlertReconciler,
  RunAlertReconciliationLoop,
  type ClaimedRunAlertEvaluation,
  type RunAlertEvaluationRepository,
  type RunAlertReconciliationScheduler
} from "./run-alert-reconciler.ts";

function summary(runId: string): RunAlertSummary {
  return {
    runId,
    monitoredModelId: "model-1",
    brand: "Fixture",
    standardModel: "MODEL-1",
    comparisonType: "BARE",
    owner: "fixture-owner",
    completedAt: new Date("2026-08-25T01:31:00.000Z"),
    checkedItemCount: 1,
    positionCount: 1,
    shopCount: 1,
    searchLimit: 1,
    skuCount: 2,
    issueCount: 0,
    reviewCount: 0,
    reportUrl: `https://monitor.example.test/collection-runs/${runId}`,
    baseline: {
      snapshotId: "own-snapshot",
      skuId: "own-sku",
      skuText: "MODEL-1 单机",
      activityPriceFen: 1_000,
      publicDiscountFen: 0,
      payableFen: 1_000
    },
    systemIssue: null,
    alerts: [],
    missingOwnGroups: []
  };
}

class FakeEvaluationRepository implements RunAlertEvaluationRepository {
  readonly pending = new Set<string>();
  readonly completed: string[] = [];
  readonly failures: string[] = [];
  private claimed = new Set<string>();

  async claimRun(runId: string | null): Promise<ClaimedRunAlertEvaluation | null> {
    const selected = runId ?? [...this.pending][0] ?? null;
    if (!selected || !this.pending.has(selected) || this.claimed.has(selected)) return null;
    this.claimed.add(selected);
    return { runId: selected, attemptToken: `token-${selected}` };
  }

  async markEvaluated(claim: ClaimedRunAlertEvaluation): Promise<void> {
    this.pending.delete(claim.runId);
    this.claimed.delete(claim.runId);
    this.completed.push(claim.runId);
  }

  async recordEvaluationFailure(claim: ClaimedRunAlertEvaluation): Promise<void> {
    this.claimed.delete(claim.runId);
    this.failures.push(claim.runId);
  }
}

test("a reconstructed reconciler retries the durable notification summary after process restart", async () => {
  const evaluations = new FakeEvaluationRepository();
  const durablePending = [summary("run-restart")];
  const restartedAttempts: string[] = [];
  const restarted = new RunAlertReconciler(
    evaluations,
    { evaluateRun: async (runId) => summary(runId) },
    { send: async (input) => { restartedAttempts.push(input.runId); durablePending.length = 0; } },
    { listRetryableSummaries: async () => durablePending }
  );
  await restarted.reconcilePending();
  await restarted.reconcilePending();

  assert.deepEqual(restartedAttempts, ["run-restart"]);
});

test("reconciles a newly ingested run durably and records evaluation failure for retry", async () => {
  const evaluations = new FakeEvaluationRepository();
  evaluations.pending.add("run-ok");
  evaluations.pending.add("run-fail");
  const notified: string[] = [];
  const reconciler = new RunAlertReconciler(
    evaluations,
    {
      evaluateRun: async (runId) => {
        if (runId === "run-fail") throw new Error("database unavailable");
        return summary(runId);
      }
    },
    { send: async (input) => { notified.push(input.runId); } },
    { listRetryableSummaries: async () => [] }
  );

  await reconciler.reconcileRun("run-ok");
  await reconciler.reconcileRun("run-fail");

  assert.deepEqual(notified, ["run-ok"]);
  assert.deepEqual(evaluations.completed, ["run-ok"]);
  assert.deepEqual(evaluations.failures, ["run-fail"]);
});

test("runs reconciliation at startup and on an interval without overlapping", async () => {
  let callback: () => void = () => undefined;
  let intervalActive = false;
  const scheduler: RunAlertReconciliationScheduler = {
    setInterval(next) { callback = next; intervalActive = true; return 1; },
    clearInterval() { intervalActive = false; }
  };
  let calls = 0;
  let release!: () => void;
  const loop = new RunAlertReconciliationLoop(
    { reconcilePending: async () => { calls += 1; if (calls === 2) await new Promise<void>((resolve) => { release = resolve; }); } },
    scheduler,
    30_000
  );

  await loop.start();
  assert.equal(calls, 1);
  assert.equal(intervalActive, true);
  callback();
  callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
  release();
  await loop.close();
  assert.equal(intervalActive, false);
});
