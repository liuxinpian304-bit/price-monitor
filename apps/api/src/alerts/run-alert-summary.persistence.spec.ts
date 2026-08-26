import assert from "node:assert/strict";
import test from "node:test";

import type { Prisma } from "../../../../generated/prisma/client.ts";
import type { RunAlertSummary } from "../collection/run-alert.service.ts";
import {
  runAlertSummaryFromJson,
  runAlertSummaryToJson,
  RunAlertNotificationPersistenceError
} from "./run-alert-summary.persistence.ts";

function summary(): RunAlertSummary {
  return {
    runId: "run-persistence",
    monitoredModelId: "model-1",
    brand: "Sony",
    standardModel: "MDR-7506",
    comparisonType: "BARE",
    owner: "fixture-owner",
    completedAt: new Date("2026-08-25T01:31:00.000Z"),
    checkedItemCount: 50,
    searchLimit: 50,
    skuCount: 76,
    issueCount: 0,
    reportUrl: "https://monitor.example.test/collection-runs/run-persistence",
    baseline: {
      snapshotId: "own-snapshot",
      skuId: "own-sku",
      skuText: "MDR-7506 单机",
      activityPriceFen: 69_800,
      publicDiscountFen: 0,
      payableFen: 69_800
    },
    systemIssue: null,
    alerts: [{
      alertId: "alert-1",
      severity: "CONFIRMED_LOW",
      snapshotId: "competitor-snapshot",
      rank: 1,
      shopName: "同行店铺",
      title: "Sony MDR-7506",
      skuText: "MDR-7506 单机",
      activityPriceFen: 69_799,
      publicDiscountFen: 0,
      payableFen: 69_799,
      differenceFen: 1,
      url: "https://item.taobao.com/item.htm?id=1",
      reasons: ["同配置裸机"]
    }]
  };
}

test("round trips a strict run alert summary and restores its completion date", () => {
  const input = summary();

  const restored = runAlertSummaryFromJson(
    runAlertSummaryToJson(input) as Prisma.JsonValue
  );

  assert.deepEqual(restored, input);
  assert.equal(restored.completedAt instanceof Date, true);
});

test("rejects malformed or extended stored summaries with one sanitized error", () => {
  const valid = runAlertSummaryToJson(summary()) as Prisma.JsonObject;
  const invalid: Prisma.JsonValue[] = [
    { ...valid, checkedItemCount: -1 },
    { ...valid, unexpected: true },
    { ...valid, completedAt: "not-a-date" },
    {
      ...valid,
      baseline: {
        ...(valid.baseline as Prisma.JsonObject),
        unexpected: true
      }
    }
  ];

  for (const value of invalid) {
    assert.throws(
      () => runAlertSummaryFromJson(value),
      (error: unknown) => {
        assert.equal(error instanceof RunAlertNotificationPersistenceError, true);
        assert.equal((error as Error).name, "RunAlertNotificationPersistenceError");
        assert.equal((error as Error).message, "Run alert notification persistence failed");
        return true;
      }
    );
  }
});
