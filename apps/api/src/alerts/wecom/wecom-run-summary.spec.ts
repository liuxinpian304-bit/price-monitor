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
    positionCount: 50,
    shopCount: 12,
    searchLimit: 50,
    skuCount: 76,
    issueCount: 2,
    reviewCount: 3,
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
      ownSnapshotId: "own-snapshot",
      ownSkuText: "MDR-7506 单机",
      ownPayableFen: 69_800,
      combinationSignature: "sku-combination-v1:fixture",
      combinationLabel: "Sony MDR-7506 新品 核心耳机MDR-7506x1",
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
    }],
    missingOwnGroups: []
  };
}

test("formats every required run and low-SKU field when the full summary fits", () => {
  const content = buildWecomRunSummary(summary());

  assert.match(content, /Sony MDR-7506/);
  assert.match(content, /裸机/);
  assert.match(content, /前50位置 50\/50/);
  assert.match(content, /MDR-7506 单机/);
  assert.match(content, /¥698\.00/);
  assert.match(content, /排名 3/);
  assert.match(content, /同行专业音频店/);
  assert.match(content, /¥697\.99/);
  assert.match(content, /¥0\.01/);
  assert.match(content, /item\.taobao\.com/);
  assert.match(content, /异常 2/);
  assert.match(content, /monitor\.example\.test/);
  assert.ok(Array.from(content).length <= 3_500);
});

test("renders top ten confirmed lows and missing groups in stable business order", () => {
  const input = summary();
  input.positionCount = 50;
  input.alerts = Array.from({ length: 12 }, (_, index) => ({
    ...input.alerts[0]!,
    alertId: `alert-${index + 1}`,
    snapshotId: `snapshot-${index + 1}`,
    combinationSignature: `combination-${index + 1}`,
    combinationLabel: `低价组合-${index + 1}`,
    rank: index === 10 ? 2 : index === 11 ? 8 : index + 1,
    shopName: `同行店铺-${index + 1}`,
    ownPayableFen: 80_000 + index,
    payableFen: 68_000 - index * 100,
    differenceFen: index >= 10 ? 1_200 : (index + 1) * 100,
    url: `https://item.taobao.com/item.htm?id=low-${index + 1}`
  }));
  input.missingOwnGroups = Array.from({ length: 12 }, (_, index) => ({
    combinationSignature: `missing-${index + 1}`,
    combinationLabel: `待补组合-${index + 1}`,
    missingReason: "OWN_COMBINATION_ABSENT" as const,
    earliestRank: index === 0 ? 8 : index === 1 ? 2 : index + 1,
    minimumConfirmedPayableFen: index < 2 ? 60_000 : 60_000 + index * 100,
    shopCount: index + 1,
    representativeUrl: `https://item.taobao.com/item.htm?id=missing-${index + 1}`
  }));
  input.reviewCount = 3;

  const content = buildWecomRunSummary(input);

  assert.match(content, /前50位置 50\/50/);
  assert.match(content, /确认低价 12/);
  assert.match(content, /缺失组合 12/);
  assert.match(content, /人工复核 3/);
  assert.equal((content.match(/同行低价/g) ?? []).length, 10);
  assert.equal((content.match(/缺失组合：/g) ?? []).length, 10);
  assert.ok(content.indexOf("低价组合-11") < content.indexOf("低价组合-12"));
  assert.ok(content.indexOf("低价组合-12") < content.indexOf("低价组合-10"));
  assert.doesNotMatch(content, /低价组合-[12](?:\D|$)/);
  assert.ok(content.indexOf("待补组合-2") < content.indexOf("待补组合-1"));
  assert.ok(content.indexOf("待补组合-1") < content.indexOf("待补组合-3"));
  assert.doesNotMatch(content, /待补组合-(?:11|12)(?:\D|$)/);
  assert.match(content, /我方 ¥800\.10/);
  assert.doesNotMatch(content, /缺失组合：[^\n]*低价/);
  assert.match(content, /查看完整报告/);
  assert.ok(Array.from(content).length <= 3_500);
});

test("bounds Unicode code points and sanitizes untrusted text and URLs", () => {
  const input = summary();
  input.brand = `<Sony>\n${"🎧".repeat(2_000)}`;
  input.alerts = Array.from({ length: 12 }, (_, index) => ({
    ...input.alerts[0]!,
    alertId: `alert-${index + 1}`,
    snapshotId: `snapshot-${index + 1}`,
    shopName: `<同行店>\n${"长店名".repeat(100)}`,
    combinationLabel: `<组合>\n${"长配置".repeat(100)}`,
    differenceFen: 1_000 - index,
    url: index === 0
      ? "javascript:alert(1)"
      : index === 1
        ? "https://private-token@item.taobao.com/item.htm?id=2"
        : `https://item.taobao.com/item.htm?id=${index + 1}`
  }));
  input.missingOwnGroups = Array.from({ length: 12 }, (_, index) => ({
    combinationSignature: `missing-${index + 1}`,
    combinationLabel: `<缺失>\n${"长组合".repeat(100)}`,
    missingReason: "OWN_COMBINATION_ABSENT" as const,
    earliestRank: index + 1,
    minimumConfirmedPayableFen: 60_000 + index,
    shopCount: 2,
    representativeUrl: `https://item.taobao.com/item.htm?id=missing-${index + 1}`
  }));

  const content = buildWecomRunSummary(input);

  assert.ok(Array.from(content).length <= 3_500);
  assert.doesNotMatch(content, /javascript:/);
  assert.doesNotMatch(content, /private-token/);
  assert.doesNotMatch(content, /<Sony>|<同行店>|<组合>|<缺失>/);
  assert.match(content, /查看完整报告/);
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
  assert.ok(Array.from(content).length <= 3_500);
});
