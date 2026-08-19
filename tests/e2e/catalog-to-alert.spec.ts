import assert from "node:assert/strict";
import test from "node:test";

import { createMonitorHarness } from "./support/monitor-harness.ts";

test("imports Babyface Pro FS and creates one alert for each comparable bare and bundle offer lower by one fen", async () => {
  const harness = await createMonitorHarness();

  assert.deepEqual(harness.importResult, { imported: 2, updated: 0, errors: [] });

  const bareSummary = await harness.collect({
    monitorCode: "MON-0001",
    competitorPriceFen: 629_999,
    ownPriceFen: 630_000
  });
  const bundleSummary = await harness.collect({
    monitorCode: "MON-0002",
    competitorBundleModel: "MK4",
    competitorPriceFen: 799_999,
    ownPriceFen: 800_000
  });

  assert.equal(bareSummary.matched, 1);
  assert.equal(bundleSummary.matched, 1);
  assert.equal(harness.alerts.length, 2);
  assert.deepEqual(harness.alerts.map((alert) => alert.differenceFen), [1, 1]);
  assert.deepEqual(harness.alerts.map((alert) => alert.severity), ["CONFIRMED_LOW", "CONFIRMED_LOW"]);
  assert.equal(harness.notifications.length, 2);
});
