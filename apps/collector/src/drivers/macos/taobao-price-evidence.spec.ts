import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type { AxNode } from "./ax-node.ts";
import {
  parsePromotionLabel,
  readSelectedSkuEvidence,
  yuanTextToFen
} from "./taobao-price-evidence.ts";

async function fixture(name: string): Promise<AxNode> {
  const url = new URL(`../../../test/fixtures/ax/${name}`, import.meta.url);
  return JSON.parse(await readFile(url, "utf8")) as AxNode;
}

test("parses activity prices only from the selected-SKU price region", async () => {
  const defaultView = readSelectedSkuEvidence(await fixture("item-7506-default.json"));
  const cableView = readSelectedSkuEvidence(await fixture("item-7506-cable.json"));
  assert.equal(defaultView.activityPriceFen, 65_800);
  assert.equal(cableView.activityPriceFen, 72_800);
  assert.equal(defaultView.listPriceText, "699.00");
  assert.equal(cableView.activityPriceText, "728.00");
});

test("strictly parses supported public promotion patterns", () => {
  assert.deepEqual(parsePromotionLabel("店铺券 满600减20", "shop-coupon"), {
    kind: "COUPON", label: "店铺券 满600减20", amountFen: 2_000, thresholdFen: 60_000,
    audience: "PUBLIC", stackGroup: "shop-coupon", includedInActivityPrice: false
  });
  assert.deepEqual(parsePromotionLabel("20元券", "shop-coupon"), {
    kind: "COUPON", label: "20元券", amountFen: 2_000, thresholdFen: null,
    audience: "PUBLIC", stackGroup: "shop-coupon", includedInActivityPrice: false
  });
  assert.deepEqual(parsePromotionLabel("立减10元", "direct-reduction"), {
    kind: "DIRECT_DISCOUNT", label: "立减10元", amountFen: 1_000, thresholdFen: 0,
    audience: "PUBLIC", stackGroup: "direct-reduction", includedInActivityPrice: false
  });
});

test("marks account-specific benefits non-public and never infers stacking", () => {
  const member = parsePromotionLabel("88VIP 满500减50", null);
  assert.equal(member?.audience, "88VIP");
  assert.equal(member?.stackGroup, null);
  const account = parsePromotionLabel("该账号专享 30元券", null);
  assert.equal(account?.audience, "ACCOUNT");
  const packet = parsePromotionLabel("个人红包 5元", null);
  assert.equal(packet?.audience, "PERSONAL_RED_PACKET");
});

test("rejects ambiguous, unscoped, malformed, and excessive-precision numbers", () => {
  assert.equal(parsePromotionLabel("优惠 20元", null), null);
  assert.equal(parsePromotionLabel("满600减20 再减5", null), null);
  assert.throws(() => yuanTextToFen("价格 10.999"), /valid decimal yuan/);
  assert.throws(() => yuanTextToFen("区间 10.00-20.00"), /exactly one/);
});
