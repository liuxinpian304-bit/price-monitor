import assert from "node:assert/strict";
import test from "node:test";

import type { RunAlertSummary } from "../../collection/run-alert.service.ts";
import { buildWecomRunSummary } from "./wecom-run-summary.ts";

function summary(): RunAlertSummary {
  return {
    runId: "run-1",
    monitoredModelId: "model-1",
    brand: "Sony",
    standardModel: "MDR-7506",
    comparisonType: "BARE",
    owner: "张三",
    completedAt: new Date("2026-08-25T01:31:00.000Z"),
    checkedItemCount: 49,
    searchLimit: 50,
    skuCount: 76,
    issueCount: 2,
    reportUrl: "https://monitor.example.test/collection-runs/run-1",
    baseline: {
      snapshotId: "own-snapshot",
      skuId: "own-sku",
      skuText: "MDR-7506 单机",
      activityPriceFen: 72_800,
      publicDiscountFen: 3_000,
      payableFen: 69_800
    },
    systemIssue: null,
    alerts: [{
      alertId: "alert-1",
      severity: "CONFIRMED_LOW",
      snapshotId: "competitor-snapshot",
      rank: 3,
      shopName: "同行专业音频店",
      title: "Sony MDR-7506 专业监听耳机",
      skuText: "MDR-7506 单机",
      activityPriceFen: 69_799,
      publicDiscountFen: 0,
      payableFen: 69_799,
      differenceFen: 1,
      url: "https://item.taobao.com/item.htm?id=competitor-1",
      reasons: ["同品牌、同型号、同版本裸机"]
    }]
  };
}

test("formats every required run and low-SKU field when the full summary fits", () => {
  const content = buildWecomRunSummary(summary());

  assert.match(content, /Sony MDR-7506/);
  assert.match(content, /裸机/);
  assert.match(content, /49\/50/);
  assert.match(content, /MDR-7506 单机/);
  assert.match(content, /¥728\.00/);
  assert.match(content, /¥30\.00/);
  assert.match(content, /¥698\.00/);
  assert.match(content, /排名 3/);
  assert.match(content, /同行专业音频店/);
  assert.match(content, /¥697\.99/);
  assert.match(content, /¥0\.01/);
  assert.match(content, /item\.taobao\.com/);
  assert.match(content, /异常 2/);
  assert.match(content, /monitor\.example\.test/);
  assert.ok(Array.from(content).length < 3_500);
});
test("falls back to the five largest differences in one bounded message", () => {
  const input = summary();
  input.alerts = Array.from({ length: 8 }, (_, index) => ({
    ...input.alerts[0]!,
    alertId: `alert-${index + 1}`,
    snapshotId: `snapshot-${index + 1}`,
    rank: index + 1,
    shopName: `同行店铺-${index + 1}-${"很长的店铺名".repeat(80)}`,
    title: `Sony MDR-7506-${index + 1}-${"很长的商品标题".repeat(100)}`,
    skuText: `SKU-${index + 1}-${"配置".repeat(100)}`,
    payableFen: 69_800 - (index + 1) * 100,
    differenceFen: (index + 1) * 100,
    url: `https://item.taobao.com/item.htm?id=${index + 1}&description=${"x".repeat(500)}`
  }));

  const content = buildWecomRunSummary(input);

  assert.ok(Array.from(content).length < 3_500);
  assert.match(content, /共 8 个新事件/);
  assert.match(content, /价差最大 5 个/);
  for (const index of [8, 7, 6, 5, 4]) assert.match(content, new RegExp(`SKU-${index}`));
  for (const index of [1, 2, 3]) assert.doesNotMatch(content, new RegExp(`SKU-${index}`));
  assert.match(content, /异常 2/);
  assert.match(content, /monitor\.example\.test/);
});

test("formats one own-baseline system summary without competitor conclusions", () => {
  const input = summary();
  input.baseline = null;
  input.systemIssue = "OWN_BASELINE_AMBIGUOUS";
  input.alerts = [];
  input.issueCount = 3;

  const content = buildWecomRunSummary(input);

  assert.match(content, /我方基准存在多个匹配/);
  assert.doesNotMatch(content, /同行低价/);
  assert.doesNotMatch(content, /同行专业音频店/);
  assert.match(content, /异常 3/);
  assert.match(content, /monitor\.example\.test/);
  assert.ok(Array.from(content).length < 3_500);
});
