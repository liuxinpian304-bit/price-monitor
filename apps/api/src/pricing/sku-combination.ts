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
  brand: string;
  standardModel: string;
  version: string | null;
  condition: "new";
  color: string | null;
  attributes: Array<{ key: string; value: string }>;
  components: Array<{
    role: "CORE" | "PAID_ACCESSORY";
    accessoryType: string;
    brand: string | null;
    modelOrName: string;
    quantity: number;
  }>;
}

export type SkuCombinationBuildResult =
  | { kind: "SIGNED"; signature: string; label: string; canonical: CanonicalSkuCombination; reasons: string[] }
  | { kind: "REVIEW"; signature: null; label: string | null; reasons: string[] }
  | { kind: "EXCLUDED"; signature: null; label: null; reasons: string[] };

type IncludedComponent = CanonicalSkuCombination["components"][number];

const CONDITION_EXCLUSIONS = ["二手", "样机", "展示机", "翻新", "租赁", "定金"];
const MATERIAL_ATTRIBUTE_KEY = /版本|区域|地区|国行|保修|质保/u;
const COLOR_ATTRIBUTE_KEY = /颜色|色号/u;

function review(reason: string): SkuCombinationBuildResult {
  return { kind: "REVIEW", signature: null, label: null, reasons: [reason] };
}

function excluded(reason: string): SkuCombinationBuildResult {
  return { kind: "EXCLUDED", signature: null, label: null, reasons: [reason] };
}

function compareText(left: string, right: string): number {
  return left === right ? 0 : (left < right ? -1 : 1);
}

function compareComponents(left: IncludedComponent, right: IncludedComponent): number {
  return compareText(left.role, right.role)
    || compareText(left.accessoryType, right.accessoryType)
    || compareText(left.brand ?? "", right.brand ?? "")
    || compareText(left.modelOrName, right.modelOrName)
    || left.quantity - right.quantity;
}

function compareAttributes(left: { key: string; value: string }, right: { key: string; value: string }): number {
  return compareText(left.key, right.key) || compareText(left.value, right.value);
}

function hasExcludedCondition(title: string, skuText: string): string | undefined {
  const searchable = `${title} ${skuText}`.normalize("NFKC");
  return CONDITION_EXCLUSIONS.find((term) => searchable.includes(term));
}

function normalizedAttributes(input: SkuCombinationInput): {
  color: string | null;
  attributes: CanonicalSkuCombination["attributes"];
} | SkuCombinationBuildResult {
  const entries = Object.entries(input.attributes).map(([key, value]) => ({
    key: normalizeText(key),
    value: normalizeText(value)
  }));
  const material = entries.filter(({ key }) => MATERIAL_ATTRIBUTE_KEY.test(key));
  if (material.some(({ value }) => value === "")) {
    return review("关键规格属性为空，无法可靠比较");
  }

  if (!input.colorComparable) {
    return { color: null, attributes: material.sort(compareAttributes) };
  }

  const color = entries.find(({ key }) => COLOR_ATTRIBUTE_KEY.test(key));
  if (!color || color.value === "") {
    return review("颜色可比但未提供明确颜色");
  }
  return { color: color.value, attributes: material.sort(compareAttributes) };
}

function normalizedComponents(input: SkuCombinationInput): {
  components: IncludedComponent[];
  giftOrServiceIncluded: boolean;
} | SkuCombinationBuildResult {
  if (!input.components) {
    return review("缺少组合组件，无法可靠比较");
  }

  if (input.components.some((component) => component.role === "UNKNOWN")) {
    return review("组件角色未知，无法可靠比较");
  }

  const components: IncludedComponent[] = [];
  let giftOrServiceIncluded = false;
  for (const component of input.components) {
    if (!Number.isSafeInteger(component.quantity) || component.quantity <= 0) {
      return review("组件数量无效，无法可靠比较");
    }
    const accessoryType = normalizeText(component.accessoryType);
    const modelOrName = normalizeText(component.modelOrName);
    if (accessoryType === "" || modelOrName === "") {
      return review("组件名称为空，无法可靠比较");
    }
    if (component.role === "GIFT_OR_SERVICE") {
      giftOrServiceIncluded = true;
      continue;
    }
    if (component.role !== "CORE" && component.role !== "PAID_ACCESSORY") {
      return review("组件角色未知，无法可靠比较");
    }

    const brand = component.brand === null ? null : normalizeText(component.brand) || null;
    components.push({
      role: component.role,
      accessoryType,
      brand,
      modelOrName,
      quantity: component.quantity
    });
  }

  if (!components.some((component) => component.role === "CORE")) {
    return review("缺少核心组件，无法可靠比较");
  }
  return { components: components.sort(compareComponents), giftOrServiceIncluded };
}

function isBuildResult(
  value: { color: string | null; attributes: CanonicalSkuCombination["attributes"] } | SkuCombinationBuildResult
): value is SkuCombinationBuildResult {
  return "kind" in value;
}

function buildLabel(canonical: CanonicalSkuCombination): string {
  const core = canonical.components
    .filter((component) => component.role === "CORE")
    .map((component) => `${component.modelOrName}x${component.quantity}`)
    .join("、");
  const paidAccessories = canonical.components
    .filter((component) => component.role === "PAID_ACCESSORY")
    .map((component) => `${component.accessoryType}${component.modelOrName}x${component.quantity}`)
    .join("、");
  const parts = [
    `${canonical.brand} ${canonical.standardModel}`,
    "新品",
    `核心${core}`,
    paidAccessories ? `付费配件${paidAccessories}` : "",
    canonical.version ?? "",
    ...canonical.attributes.map((attribute) => `${attribute.key}${attribute.value}`),
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

  const brand = normalizeText(input.brand);
  const standardModel = normalizeText(input.standardModel);
  if (brand === "" || standardModel === "") {
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

  const version = input.version === null ? null : normalizeText(input.version) || null;
  const canonical: CanonicalSkuCombination = {
    brand,
    standardModel,
    version,
    condition: "new",
    color: attributes.color,
    attributes: attributes.attributes,
    components: components.components
  };
  const signature = `sku-combination-v1:${createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex")}`;
  const reasons = components.giftOrServiceIncluded ? ["赠品或服务未计入组合签名"] : [];
  return { kind: "SIGNED", signature, label: buildLabel(canonical), canonical, reasons };
}
