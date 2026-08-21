import assert from "node:assert/strict";
import test from "node:test";

import type { PriceAlertRecord } from "../alert.service.ts";
import { buildWecomPriceAlertMessage } from "./wecom.message.ts";

const alert: PriceAlertRecord = {
  id: "alert-1",
  monitoredModelId: "model-1",
  severity: "CONFIRMED_LOW",
  status: "PENDING",
  dedupKey: "dedup-key",
  brand: "RME",
  standardModel: "Babyface Pro FS",
  comparisonType: "BARE",
  owner: "张三",
  ownSnapshotId: "own-snapshot-1",
  competitorSnapshotId: "competitor-snapshot-1",
  ownShopName: "星空乐器专营店",
  ownSkuText: "Babyface Pro FS单机",
  ownPriceFen: 630_000,
  competitorShopName: "同行专业音频店",
  competitorSkuText: "Babyface Pro FS单机",
  competitorPriceFen: 629_999,
  competitorItemId: "competitor-1001",
  competitorSkuId: "competitor-sku",
  competitorUrl: "https://detail.tmall.com/item.htm?id=competitor-1001",
  differenceFen: 1,
  reasons: ["同品牌、同型号、同版本裸机"],
  firstSeenAt: new Date("2026-08-19T01:30:05.000Z"),
  lastSeenAt: new Date("2026-08-19T01:30:05.000Z"),
  notifiedAt: null
};

test("builds a complete WeCom markdown alert", () => {
  const message = buildWecomPriceAlertMessage(alert);

  assert.equal(message.msgtype, "markdown");
  assert.equal(message.markdown.content, [
    "### 天猫低价预警（确定低价）",
    "> 型号：RME Babyface Pro FS",
    "> 类型：裸机",
    "> 我方：星空乐器专营店 / Babyface Pro FS单机 / **¥6300.00**",
    "> 同行：同行专业音频店 / Babyface Pro FS单机 / <font color=\"warning\">**¥6299.99**</font>",
    "> 价差：**¥0.01**",
    "> 负责人：张三",
    "> 发现时间：2026-08-19 09:30:05",
    "> 依据：同品牌、同型号、同版本裸机",
    "[打开同行商品](https://detail.tmall.com/item.htm?id=competitor-1001)"
  ].join("\n"));
});
