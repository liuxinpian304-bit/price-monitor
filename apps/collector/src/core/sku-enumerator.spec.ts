import assert from "node:assert/strict";
import test from "node:test";

import { enumerateSkuSelections } from "./sku-enumerator.ts";

test("enumerates every enabled combination in page order", () => {
  assert.deepEqual(enumerateSkuSelections([
    { name: "型号", options: [
      { id: "7506", label: "7506", enabled: true },
      { id: "m1", label: "M1", enabled: true }
    ] },
    { name: "套装", options: [
      { id: "bare", label: "单机", enabled: true },
      { id: "cable", label: "C口转换线", enabled: true }
    ] }
  ]), [
    { 型号: "7506", 套装: "单机" },
    { 型号: "7506", 套装: "C口转换线" },
    { 型号: "M1", 套装: "单机" },
    { 型号: "M1", 套装: "C口转换线" }
  ]);
});

test("returns one default selection for a product without dimensions", () => {
  assert.deepEqual(enumerateSkuSelections([]), [{}]);
});

test("does not generate a disabled option", () => {
  const selections = enumerateSkuSelections([{
    name: "规格",
    options: [{ id: "sold-out", label: "售罄", enabled: false }]
  }]);
  assert.deepEqual(selections, []);
});

test("rejects duplicate dimension names", () => {
  assert.throws(() => enumerateSkuSelections([
    { name: "颜色", options: [] },
    { name: "颜色", options: [] }
  ]), TypeError);
});

test("rejects duplicate option labels in a dimension", () => {
  assert.throws(() => enumerateSkuSelections([{
    name: "颜色",
    options: [
      { id: "red-1", label: "红色", enabled: true },
      { id: "red-2", label: "红色", enabled: false }
    ]
  }]), TypeError);
});
