import { createHash } from "node:crypto";

import { normalizeText } from "../matching/matcher.service.ts";

export interface SkuCombinationInput {
  productDecision: "BARE" | "BUNDLE" | "REJECTED" | "MANUAL" | "PENDING" | null;
  brand: string;
  standardModel: string;
  version: string | null;
  colorComparable: boolean;
  title: string;
  skuText: string;
  attributes: Record<string, string>;
  components: Array<{
    role: "CORE" | "PAID_ACCESSORY" | "GIFT_OR_SERVICE" | "UNKNOWN";
    accessoryType: string;
    brand: string | null;
    modelOrName: string;
    quantity: number;
  }> | null;
}

export interface CanonicalSkuCombination {
  version: "sku-combination-v1";
  brand: string;
  model: string;
  condition: "new";
  core: Array<{ model: string; quantity: number }>;
  paidAccessories: Array<{ model: string; quantity: number }>;
  materialAttributes: Record<string, string>;
  color: string | null;
}

export type SkuCombinationBuildResult =
  | { kind: "SIGNED"; signature: string; label: string; canonical: CanonicalSkuCombination; reasons: string[] }
  | { kind: "REVIEW"; signature: null; label: string | null; reasons: string[] }
  | { kind: "EXCLUDED"; signature: null; label: null; reasons: string[] };

type CanonicalComponent = CanonicalSkuCombination["core"][number];
type NormalizedComponent = CanonicalComponent & {
  role: "CORE" | "PAID_ACCESSORY";
  accessoryType: string;
  brand: string | null;
};

const MANDATORY_EXCLUSIONS = [
  "二手", "样机", "展示机", "翻新", "租赁", "定金", "维修", "空盒", "单独配件"
];
const MATERIAL_ATTRIBUTE_KEY = /版本|区域|地区|国行|保修|质保/u;
const COLOR_ATTRIBUTE_KEY = /颜色|色号/u;

function review(reason: string): SkuCombinationBuildResult {
  return { kind: "REVIEW", signature: null, label: null, reasons: [reason] };
}

function excluded(reason: string): SkuCombinationBuildResult {
  return { kind: "EXCLUDED", signature: null, label: null, reasons: [reason] };
}

function normalizeIdentifier(value: string): string {
  return normalizeText(value).replace(/\s+/g, "");
}

function compareText(left: string, right: string): number {
  return left === right ? 0 : (left < right ? -1 : 1);
}

function compareCanonicalComponents(left: CanonicalComponent, right: CanonicalComponent): number {
  return compareText(left.model, right.model) || left.quantity - right.quantity;
}

function compareAttributes(left: { key: string; value: string }, right: { key: string; value: string }): number {
  return compareText(left.key, right.key) || compareText(left.value, right.value);
}

function hasExcludedCondition(title: string, skuText: string): string | undefined {
  const searchable = `${title} ${skuText}`.normalize("NFKC");
  return MANDATORY_EXCLUSIONS.find((term) => searchable.includes(term));
}

function normalizedAttributes(input: SkuCombinationInput): {
  color: string | null;
  materialAttributes: CanonicalSkuCombination["materialAttributes"];
} | SkuCombinationBuildResult {
  const entries = Object.entries(input.attributes).map(([key, value]) => ({
    key: normalizeText(key),
    value: normalizeText(value)
  }));
  const materialEntries = entries
    .filter(({ key }) => !COLOR_ATTRIBUTE_KEY.test(key) && MATERIAL_ATTRIBUTE_KEY.test(key))
    .sort(compareAttributes);
  if (materialEntries.some(({ value }) => value === "")) {
    return review("关键规格属性为空，无法可靠比较");
  }

  const materialAttributes: Record<string, string> = {};
  for (const attribute of materialEntries) {
    const existing = materialAttributes[attribute.key];
    if (existing !== undefined && existing !== attribute.value) {
      return review("关键规格属性冲突，无法可靠比较");
    }
    materialAttributes[attribute.key] = attribute.value;
  }

  if (!input.colorComparable) {
    return { color: null, materialAttributes };
  }

  const color = entries.find(({ key }) => COLOR_ATTRIBUTE_KEY.test(key));
  if (!color || color.value === "") {
    return review("颜色可比但未提供明确颜色");
  }
  return { color: color.value, materialAttributes };
}

function normalizedComponents(input: SkuCombinationInput): {
  components: NormalizedComponent[];
  giftOrServiceIncluded: boolean;
} | SkuCombinationBuildResult {
  if (!input.components) {
    return review("缺少组合组件，无法可靠比较");
  }

  if (input.components.some((component) => component.role === "UNKNOWN")) {
    return review("组件角色未知，无法可靠比较");
  }

  const components: NormalizedComponent[] = [];
  let giftOrServiceIncluded = false;
  for (const component of input.components) {
    if (!Number.isSafeInteger(component.quantity) || component.quantity <= 0) {
      return review("组件数量无效，无法可靠比较");
    }
    const accessoryType = normalizeText(component.accessoryType);
    const model = normalizeIdentifier(component.modelOrName);
    if (accessoryType === "" || model === "") {
      return review("组件名称为空，无法可靠比较");
    }
    if (component.role === "GIFT_OR_SERVICE") {
      giftOrServiceIncluded = true;
      continue;
    }
    if (component.role !== "CORE" && component.role !== "PAID_ACCESSORY") {
      return review("组件角色未知，无法可靠比较");
    }

    components.push({
      role: component.role,
      accessoryType,
      brand: component.brand === null ? null : normalizeIdentifier(component.brand) || null,
      model,
      quantity: component.quantity
    });
  }

  if (!components.some((component) => component.role === "CORE")) {
    return review("缺少核心组件，无法可靠比较");
  }
  return { components, giftOrServiceIncluded };
}

function isBuildResult(
  value: { color: string | null; materialAttributes: CanonicalSkuCombination["materialAttributes"] } | SkuCombinationBuildResult
): value is SkuCombinationBuildResult {
  return "kind" in value;
}

function buildLabel(
  canonical: CanonicalSkuCombination,
  components: NormalizedComponent[],
  version: string | null
): string {
  const core = components
    .filter((component) => component.role === "CORE")
    .map((component) => `${component.accessoryType}${component.model}x${component.quantity}`)
    .join("、");
  const paidAccessories = components
    .filter((component) => component.role === "PAID_ACCESSORY")
    .map((component) => `${component.accessoryType}${component.model}x${component.quantity}`)
    .join("、");
  const parts = [
    `${canonical.brand} ${canonical.model}`,
    "新品",
    `核心${core}`,
    paidAccessories ? `付费配件${paidAccessories}` : "",
    version ?? "",
    ...Object.entries(canonical.materialAttributes).map(([key, value]) => `${key}${value}`),
    canonical.color ? `颜色${canonical.color}` : ""
  ];
  return parts.filter(Boolean).join(" ");
}

export function buildSkuCombination(input: SkuCombinationInput): SkuCombinationBuildResult {
  if (input.productDecision === "REJECTED") {
    return excluded("商品已被产品匹配拒绝");
  }
  if (input.productDecision === null || input.productDecision === "PENDING" || input.productDecision === "MANUAL") {
    return review("产品匹配尚未形成精确比较结论");
  }

  const excludedCondition = hasExcludedCondition(input.title, input.skuText);
  if (excludedCondition) {
    return excluded(`商品包含${excludedCondition}状态，排除比较`);
  }

  const brand = normalizeIdentifier(input.brand);
  const model = normalizeIdentifier(input.standardModel);
  if (brand === "" || model === "") {
    return review("监控品牌或标准型号为空，无法可靠比较");
  }

  const attributes = normalizedAttributes(input);
  if (isBuildResult(attributes)) {
    return attributes;
  }
  const components = normalizedComponents(input);
  if ("kind" in components) {
    return components;
  }

  const canonical: CanonicalSkuCombination = {
    version: "sku-combination-v1",
    brand,
    model,
    condition: "new",
    core: components.components
      .filter((component) => component.role === "CORE")
      .map(({ model: componentModel, quantity }) => ({ model: componentModel, quantity }))
      .sort(compareCanonicalComponents),
    paidAccessories: components.components
      .filter((component) => component.role === "PAID_ACCESSORY")
      .map(({ model: componentModel, quantity }) => ({ model: componentModel, quantity }))
      .sort(compareCanonicalComponents),
    materialAttributes: attributes.materialAttributes,
    color: attributes.color
  };
  const signature = `sku-combination-v1:${createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex")}`;
  const reasons = components.giftOrServiceIncluded ? ["赠品或服务未计入组合签名"] : [];
  const version = input.version === null ? null : normalizeText(input.version) || null;
  return { kind: "SIGNED", signature, label: buildLabel(canonical, components.components, version), canonical, reasons };
}
