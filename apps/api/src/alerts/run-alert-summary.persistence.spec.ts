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
    positionCount: 50,
    shopCount: 12,
    searchLimit: 50,
    skuCount: 76,
    issueCount: 0,
    reviewCount: 3,
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
      ownSnapshotId: "own-snapshot",
      ownSkuText: "MDR-7506 单机",
      ownPayableFen: 69_800,
      combinationSignature: "sku-combination-v1:single",
      combinationLabel: "Sony MDR-7506 新品 核心耳机MDR-7506x1",
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
    }],
    missingOwnGroups: [{
      combinationSignature: "sku-combination-v1:bundle",
      combinationLabel: "Sony MDR-7506 新品 核心耳机MDR-7506x1 付费配件转换线C口x1",
      missingReason: "OWN_COMBINATION_ABSENT",
      earliestRank: 9,
      minimumConfirmedPayableFen: 65_000,
      shopCount: 2,
      representativeUrl: "https://item.taobao.com/item.htm?id=missing"
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

test("normalizes a stored price-v2 summary so old runs remain readable", () => {
  const legacy = runAlertSummaryToJson(summary()) as Prisma.JsonObject;
  delete legacy.positionCount;
  delete legacy.shopCount;
  delete legacy.reviewCount;
  delete legacy.missingOwnGroups;
  const legacyAlert = (legacy.alerts as Prisma.JsonArray)[0] as Prisma.JsonObject;
  delete legacyAlert.ownSnapshotId;
  delete legacyAlert.ownSkuText;
  delete legacyAlert.ownPayableFen;
  delete legacyAlert.combinationSignature;
  delete legacyAlert.combinationLabel;

  const restored = runAlertSummaryFromJson(legacy);

  assert.equal(restored.positionCount, restored.checkedItemCount);
  assert.equal(restored.shopCount, 1);
  assert.equal(restored.reviewCount, 0);
  assert.deepEqual(restored.missingOwnGroups, []);
  assert.equal(restored.alerts[0]?.ownSnapshotId, restored.baseline?.snapshotId);
  assert.equal(restored.alerts[0]?.combinationSignature, "legacy-price-v2:alert-1");
});

test("rejects malformed or extended stored summaries with one sanitized error", () => {
  const valid = runAlertSummaryToJson(summary()) as Prisma.JsonObject;
  const invalid: Prisma.JsonValue[] = [
    { ...valid, checkedItemCount: -1 },
    { ...valid, reviewCount: -1 },
    { ...valid, unexpected: true },
    { ...valid, completedAt: "not-a-date" },
    {
      ...valid,
      baseline: {
        ...(valid.baseline as Prisma.JsonObject),
        unexpected: true
      }
    },
    {
      ...valid,
      missingOwnGroups: [{
        ...((valid.missingOwnGroups as Prisma.JsonArray)[0] as Prisma.JsonObject),
        shopCount: -1
      }]
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
