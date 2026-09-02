import assert from "node:assert/strict";
import test from "node:test";

import {
  InMemoryRunAlertEvaluationRepository,
  InMemoryRunAlertNotificationRepository
} from "./support/desktop-report-harness.ts";
import { createMonitorHarness } from "./support/monitor-harness.ts";

const nt1sCore = {
  role: "CORE" as const,
  accessoryType: "microphone",
  brand: "RODE",
  modelOrName: "NT1S",
  quantity: 1
};

const ai1Accessory = {
  role: "PAID_ACCESSORY" as const,
  accessoryType: "audio interface",
  brand: "RODE",
  modelOrName: "AI-1",
  quantity: 1
};

async function collectDesktopFixtureRun() {
  const harness = await createMonitorHarness({ wecomLiveSendingApproved: false });
  return harness.collectDesktopCombinationRun({
    own: [
      { itemId: "own-a", skuId: "single-high", payableFen: 148_001, components: [nt1sCore] },
      { itemId: "own-b", skuId: "single-low", payableFen: 148_000, components: [nt1sCore] }
    ],
    competitors: [
      {
        itemId: "competitor-low",
        skuId: "single",
        payableFen: 147_999,
        components: [nt1sCore],
        ranks: [1, 4]
      },
      {
        itemId: "competitor-bundle",
        skuId: "ai1",
        payableFen: 188_000,
        components: [nt1sCore, ai1Accessory],
        ranks: [2]
      }
    ]
  });
}

test("builds one-fen lows and missing groups from exact SKU combinations", async () => {
  const run = await collectDesktopFixtureRun();

  assert.equal(run.report.confirmedLows.length, 1);
  assert.equal(run.report.confirmedLows[0]?.differenceFen, 1);
  assert.equal(run.report.confirmedLows[0]?.selectedOwnSnapshot.id, "single-low");
  assert.deepEqual(
    run.report.confirmedLows[0]?.alternativeOwnSnapshots.map((snapshot) => snapshot.id),
    ["single-high"]
  );
  assert.deepEqual(run.report.confirmedLows[0]?.ranks, [1, 4]);
  assert.equal(run.report.missingOwnGroups.length, 1);
  assert.equal(run.report.missingOwnGroups[0]?.offers.length, 1);
  assert.equal(run.alerts.length, 1);
  assert.equal(run.notificationBatchCount, 1);
  assert.equal(run.notificationBatch.state, "PENDING");
  assert.equal(run.sentMessages.length, 0);
});

test("stale notification claims cannot complete or fail a newer retry", async () => {
  const run = await collectDesktopFixtureRun();
  const repository = new InMemoryRunAlertNotificationRepository();
  const attemptedAt = new Date("2026-08-28T02:00:00.000Z");
  repository.ensureBatch(run.notificationBatch.summary);

  const first = await repository.claimBatch(run.notificationBatch.runId, attemptedAt);
  assert.ok(first);
  await repository.recordBatchNotificationFailure(first, "WECOM_DELIVERY_FAILED", attemptedAt);

  const second = await repository.claimBatch(run.notificationBatch.runId, attemptedAt);
  assert.ok(second);
  assert.notEqual(second.attemptToken, first.attemptToken);
  await assert.rejects(
    repository.markBatchNotified(first, attemptedAt),
    /notification claim is invalid/
  );
  await assert.rejects(
    repository.recordBatchNotificationFailure(first, "WECOM_DELIVERY_FAILED", attemptedAt),
    /notification claim is invalid/
  );
  assert.equal((await repository.getBatch(run.notificationBatch.runId))?.state, "SENDING");

  await repository.markBatchNotified(second, attemptedAt);
  assert.equal((await repository.getBatch(run.notificationBatch.runId))?.state, "NOTIFIED");
});

test("evaluation claims require the exact active attempt token", async () => {
  const runId = "desktop-evaluation-fencing";
  const attemptedAt = new Date("2026-08-28T02:00:00.000Z");
  const repository = new InMemoryRunAlertEvaluationRepository(runId, () => true);

  const first = await repository.claimRun(runId, attemptedAt);
  assert.ok(first);
  await repository.recordEvaluationFailure(first, attemptedAt);

  const second = await repository.claimRun(runId, attemptedAt);
  assert.ok(second);
  assert.notEqual(second.attemptToken, first.attemptToken);
  await assert.rejects(repository.markEvaluated(first, attemptedAt), /evaluation claim is invalid/);
  await assert.rejects(
    repository.recordEvaluationFailure(
      { ...second, attemptToken: `${second.attemptToken}-malformed` },
      attemptedAt
    ),
    /evaluation claim is invalid/
  );
  assert.equal(await repository.claimRun(runId, attemptedAt), null);

  await repository.markEvaluated(second, attemptedAt);
  assert.equal(await repository.claimRun(runId, attemptedAt), null);
});
