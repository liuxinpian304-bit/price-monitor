import assert from "node:assert/strict";
import test from "node:test";

import { createMonitorHarness } from "./support/monitor-harness.ts";

test("does not resend the same competitor SKU and price but notifies after another drop", async () => {
  const harness = await createMonitorHarness();

  await harness.collect({ monitorCode: "MON-0001", competitorPriceFen: 629_999, ownPriceFen: 630_000 });
  await harness.collect({ monitorCode: "MON-0001", competitorPriceFen: 629_999, ownPriceFen: 630_000 });
  await harness.collect({ monitorCode: "MON-0001", competitorPriceFen: 629_998, ownPriceFen: 630_000 });

  assert.deepEqual(harness.alerts.map((alert) => alert.competitorPriceFen), [629_999, 629_998]);
  assert.equal(harness.notifications.length, 2);
});
