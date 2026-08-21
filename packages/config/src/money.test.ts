import assert from "node:assert/strict";
import test from "node:test";

import { moneyFromYuan } from "./money.ts";

test("converts a yuan string to integer fen without floating-point rounding", () => {
  assert.equal(moneyFromYuan("5999.90"), 599990);
  assert.equal(moneyFromYuan("10.5"), 1050);
  assert.equal(moneyFromYuan("0.01"), 1);
});

test("rejects malformed or over-precise yuan values", () => {
  assert.throws(() => moneyFromYuan("1.234"), /valid yuan amount/);
  assert.throws(() => moneyFromYuan("-1"), /valid yuan amount/);
  assert.throws(() => moneyFromYuan(""), /valid yuan amount/);
});
