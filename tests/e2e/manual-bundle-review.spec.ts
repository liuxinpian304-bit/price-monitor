import assert from "node:assert/strict";
import test from "node:test";

import { createMonitorHarness } from "./support/monitor-harness.ts";

test("routes a lower differently configured bundle to manual review", async () => {
  const harness = await createMonitorHarness();

  await harness.collect({
    monitorCode: "MON-0002",
    competitorBundleModel: "MK8",
    competitorPriceFen: 799_999,
    ownPriceFen: 800_000
  });

  assert.equal(harness.alerts.length, 1);
  assert.equal(harness.alerts[0]?.severity, "MANUAL_REVIEW");
  assert.equal(harness.alerts[0]?.differenceFen, 1);
  assert.ok(harness.alerts[0]?.reasons.some((reason) => reason.includes("核心配件配置不同")));
  assert.equal(harness.notifications.length, 1);
});
