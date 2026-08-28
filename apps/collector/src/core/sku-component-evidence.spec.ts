import assert from "node:assert/strict";
import test from "node:test";

import { deriveSkuComponents } from "./sku-component-evidence.ts";

test("derives one core component for a plain single-product SKU", () => {
  assert.deepEqual(deriveSkuComponents({
    brand: "RODE",
    standardModel: "NT1S",
    selectedLabels: { "颜色分类": "黑色", "套餐类型": "单麦克风" },
    explicitComponents: undefined
  }), [{
    role: "CORE",
    accessoryType: "核心产品",
    brand: "RODE",
    modelOrName: "NT1S",
    quantity: 1
  }]);
});

test("keeps an explicit audio interface as a paid accessory", () => {
  const result = deriveSkuComponents({
    brand: "RODE",
    standardModel: "NT1S",
    selectedLabels: { "套餐类型": "NT1S + AI-1声卡" },
    explicitComponents: undefined
  });
  assert.equal(result.find((item) => item.modelOrName === "AI-1")?.role, "PAID_ACCESSORY");
});

test("marks a generic upgrade package as unknown", () => {
  const result = deriveSkuComponents({
    brand: "RODE",
    standardModel: "NT1S",
    selectedLabels: { "套餐类型": "升级套餐二" },
    explicitComponents: undefined
  });
  assert.equal(result.some((item) => item.role === "UNKNOWN"), true);
});

test("preserves driver-supplied roles without reclassifying them", () => {
  const explicit = [{
    role: "GIFT_OR_SERVICE" as const,
    accessoryType: "服务",
    brand: null,
    modelOrName: "远程调试",
    quantity: 1
  }];
  const result = deriveSkuComponents({
    brand: "RODE",
    standardModel: "NT1S",
    selectedLabels: {},
    explicitComponents: explicit
  });

  assert.deepEqual(result, explicit);
  assert.notEqual(result, explicit);
  assert.notEqual(result[0], explicit[0]);
});

test("changes core quantity only for one unambiguous count token", () => {
  const counted = deriveSkuComponents({
    brand: "RODE",
    standardModel: "NT1S",
    selectedLabels: { "麦克风数量": "2只" },
    explicitComponents: undefined
  });
  const ambiguous = deriveSkuComponents({
    brand: "RODE",
    standardModel: "NT1S",
    selectedLabels: { "麦克风数量": "2只或3只" },
    explicitComponents: undefined
  });

  assert.equal(counted[0]?.quantity, 2);
  assert.equal(ambiguous[0]?.quantity, 1);
});

test("rejects fractional and decimal quantity evidence", () => {
  for (const label of ["0.5件", "1.5套", "．5件"]) {
    const result = deriveSkuComponents({
      brand: "RODE",
      standardModel: "NT1S",
      selectedLabels: { "麦克风数量": label },
      explicitComponents: undefined
    });

    assert.equal(result[0]?.quantity, 1, label);
  }
});

test("rejects signed or otherwise ambiguous quantity evidence", () => {
  for (const label of ["-2只", "+2个", "－2只", "＋2个", "−2件", "2只或3只", "型号3 2只"]) {
    const result = deriveSkuComponents({
      brand: "RODE",
      standardModel: "NT1S",
      selectedLabels: { "麦克风数量": label },
      explicitComponents: undefined
    });

    assert.equal(result[0]?.quantity, 1, label);
  }
});

test("splits package labels and classifies gift or service tokens before accessories", () => {
  const result = deriveSkuComponents({
    brand: "RODE",
    standardModel: "NT1S",
    selectedLabels: { "套餐类型": "NT1S＋AI-1声卡/免费安装" },
    explicitComponents: undefined
  });

  assert.equal(result.find((item) => item.modelOrName === "AI-1")?.role, "PAID_ACCESSORY");
  assert.equal(result.find((item) => item.modelOrName === "免费安装")?.role, "GIFT_OR_SERVICE");
  assert.equal(result.some((item) => item.role === "UNKNOWN"), false);
});

test("does not promote a model-free accessory token to paid accessory", () => {
  const result = deriveSkuComponents({
    brand: "RODE",
    standardModel: "NT1S",
    selectedLabels: { "套餐类型": "NT1S + 专业支架" },
    explicitComponents: undefined
  });

  assert.equal(result.some((item) => item.role === "PAID_ACCESSORY"), false);
  assert.equal(result.find((item) => item.modelOrName === "专业支架")?.role, "UNKNOWN");
});

test("treats a joined core model and product type as core evidence", () => {
  const result = deriveSkuComponents({
    brand: "RODE",
    standardModel: "NT1S",
    selectedLabels: { "套餐类型": "NT1S麦克风" },
    explicitComponents: undefined
  });

  assert.deepEqual(result, [{
    role: "CORE",
    accessoryType: "核心产品",
    brand: "RODE",
    modelOrName: "NT1S",
    quantity: 1
  }]);
});

test("keeps a distinct accessory model beside joined core evidence", () => {
  const result = deriveSkuComponents({
    brand: "RODE",
    standardModel: "NT1S",
    selectedLabels: { "套餐类型": "NT1S麦克风 AI-1声卡" },
    explicitComponents: undefined
  });

  assert.equal(result.find((item) => item.modelOrName === "AI-1")?.role, "PAID_ACCESSORY");
});

test("keeps generic package text beside a core model unknown", () => {
  const result = deriveSkuComponents({
    brand: "RODE",
    standardModel: "NT1S",
    selectedLabels: { "套餐类型": "NT1S豪华套装" },
    explicitComponents: undefined
  });

  assert.equal(result.find((item) => item.modelOrName === "NT1S豪华套装")?.role, "UNKNOWN");
});

test("deduplicates only components with identical normalized evidence", () => {
  const result = deriveSkuComponents({
    brand: "RODE",
    standardModel: "NT1S",
    selectedLabels: {
      "套餐类型": "NT1S + AI-1声卡",
      "搭配方案": "NT1S搭配AI-1 声卡"
    },
    explicitComponents: undefined
  });

  assert.equal(result.filter((item) => item.modelOrName === "AI-1").length, 1);
  assert.equal(result.some((item) => "valueFen" in item), false);
});
