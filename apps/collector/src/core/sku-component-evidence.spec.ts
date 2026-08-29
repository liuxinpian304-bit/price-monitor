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
  assert.equal(ambiguous.some((item) => item.role === "UNKNOWN"), true);
});

test("preserves explicit core quantity on recognized single-product aliases", () => {
  for (const [label, expectedQuantity] of [
    ["单机2件", 2],
    ["裸机2件", 2],
    ["单品3个", 3],
    ["单麦克风2只", 2]
  ] as const) {
    const result = deriveSkuComponents({
      brand: "RODE",
      standardModel: "NT1S",
      selectedLabels: { "套餐类型": label },
      explicitComponents: undefined
    });

    assert.equal(result.find((item) => item.role === "CORE")?.quantity, expectedQuantity, label);
    assert.equal(result.some((item) => item.role === "UNKNOWN"), false, label);
  }
});

test("marks conflicting explicit core quantities unknown", () => {
  for (const label of [
    "NT1S2件/单机3件",
    "NT1S2件/单机1件",
    "单机1件/NT1S2件"
  ]) {
    const result = deriveSkuComponents({
      brand: "RODE",
      standardModel: "NT1S",
      selectedLabels: { "套餐类型": label },
      explicitComponents: undefined
    });

    assert.equal(result.some((item) => item.role === "UNKNOWN"), true, label);
  }
});

test("accepts equivalent explicit core quantities and ignores implicit alias counts", () => {
  for (const label of ["单机2件/NT1S2件", "NT1S2件/单机"]) {
    const result = deriveSkuComponents({
      brand: "RODE",
      standardModel: "NT1S",
      selectedLabels: { "套餐类型": label },
      explicitComponents: undefined
    });

    assert.equal(result.find((item) => item.role === "CORE")?.quantity, 2, label);
    assert.equal(result.some((item) => item.role === "UNKNOWN"), false, label);
  }
});

test("reconciles package-token and quantity-dimension core evidence", () => {
  for (const {
    name,
    selectedLabels,
    expectedQuantity,
    expectedUnknown
  } of [
    {
      name: "conflicting quantities",
      selectedLabels: { "套餐类型": "单机2件", "麦克风数量": "3只" },
      expectedQuantity: 2,
      expectedUnknown: true
    },
    {
      name: "equivalent quantities",
      selectedLabels: { "套餐类型": "单机2件", "麦克风数量": "2只" },
      expectedQuantity: 2,
      expectedUnknown: false
    },
    {
      name: "conflicting quantities in reverse field order",
      selectedLabels: { "麦克风数量": "3只", "套餐类型": "单机2件" },
      expectedQuantity: 2,
      expectedUnknown: true
    },
    {
      name: "explicit package quantity one conflicts with quantity dimension",
      selectedLabels: { "套餐类型": "单机1件", "麦克风数量": "2只" },
      expectedQuantity: 1,
      expectedUnknown: true
    }
  ] as const) {
    const result = deriveSkuComponents({
      brand: "RODE",
      standardModel: "NT1S",
      selectedLabels,
      explicitComponents: undefined
    });

    assert.equal(result.find((item) => item.role === "CORE")?.quantity, expectedQuantity, name);
    assert.equal(result.some((item) => item.role === "UNKNOWN"), expectedUnknown, name);
  }
});

test("attributes package quantity to the identified paid accessory", () => {
  const single = deriveSkuComponents({
    brand: "RODE",
    standardModel: "NT1S",
    selectedLabels: { "套餐类型": "NT1S + AI-1声卡1个" },
    explicitComponents: undefined
  });
  const pair = deriveSkuComponents({
    brand: "RODE",
    standardModel: "NT1S",
    selectedLabels: { "套餐类型": "NT1S + AI-1声卡2个" },
    explicitComponents: undefined
  });

  assert.equal(single.find((item) => item.modelOrName === "AI-1")?.quantity, 1);
  assert.equal(pair.find((item) => item.modelOrName === "AI-1")?.quantity, 2);
});

test("marks a generic quantity dimension unknown when a bundle has multiple components", () => {
  const result = deriveSkuComponents({
    brand: "RODE",
    standardModel: "NT1S",
    selectedLabels: {
      "套餐类型": "NT1S + AI-1声卡",
      "数量": "2件"
    },
    explicitComponents: undefined
  });

  assert.equal(result.find((item) => item.role === "CORE")?.quantity, 1);
  assert.equal(result.find((item) => item.modelOrName === "AI-1")?.quantity, 1);
  assert.equal(result.some((item) => item.role === "UNKNOWN"), true);
});

test("marks malformed paid-accessory quantity evidence unknown", () => {
  const result = deriveSkuComponents({
    brand: "RODE",
    standardModel: "NT1S",
    selectedLabels: { "套餐类型": "NT1S + AI-1声卡2个或3个" },
    explicitComponents: undefined
  });

  assert.equal(result.some((item) => item.role === "UNKNOWN"), true);
});

test("does not infer supported material attributes as components", () => {
  const result = deriveSkuComponents({
    brand: "RODE",
    standardModel: "NT1S",
    selectedLabels: {
      "套餐类型": "单麦克风",
      "版本": "国行",
      "地区": "中国大陆",
      "保修": "全国联保两年"
    },
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

test("rejects fractional and decimal quantity evidence", () => {
  for (const label of ["0.5件", "1.5套", "．5件"]) {
    const result = deriveSkuComponents({
      brand: "RODE",
      standardModel: "NT1S",
      selectedLabels: { "麦克风数量": label },
      explicitComponents: undefined
    });

    assert.equal(result[0]?.quantity, 1, label);
    assert.equal(result.some((item) => item.role === "UNKNOWN"), true, label);
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
    assert.equal(result.some((item) => item.role === "UNKNOWN"), true, label);
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

test("preserves explicit quantity on joined core model and product type evidence", () => {
  const result = deriveSkuComponents({
    brand: "RODE",
    standardModel: "NT1S",
    selectedLabels: { "套餐类型": "NT1S麦克风2件" },
    explicitComponents: undefined
  });

  assert.equal(result.find((item) => item.role === "CORE")?.quantity, 2);
  assert.equal(result.some((item) => item.role === "UNKNOWN"), false);
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
