import assert from "node:assert/strict";
import test from "node:test";

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

test("builds one-fen lows and missing groups from exact SKU combinations", async () => {
  const harness = await createMonitorHarness({ wecomLiveSendingApproved: false });
  const run = await harness.collectDesktopCombinationRun({
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
