import type { RawOffer } from "../collection/providers/commerce-provider.ts";
import type { MatchCategory, MatchDecision, MonitoredProductRule } from "./matcher.types.ts";

const BUNDLE_SIGNALS = ["套装", "组合装", "搭配", "套餐", "录音套装"];
const BARE_SIGNALS = ["单机", "裸机", "官方标配", "标准版", "单品"];

export function normalizeText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function compact(value: string): string {
  return normalizeText(value).replace(/\s+/g, "");
}

function containsPhrase(haystack: string, phrase: string): boolean {
  const needle = compact(phrase);
  return needle !== "" && compact(haystack).includes(needle);
}

function selectedSkuText(offer: RawOffer): string {
  const selected = offer.skuOptions.find((sku) => sku.skuId === offer.selectedSkuId);
  if (!selected) {
    return "";
  }
  return [selected.label, ...Object.entries(selected.attributes).flat()].join(" ");
}

function classifyOffer(offer: RawOffer): { category: MatchCategory; reason: string } {
  const skuText = selectedSkuText(offer);
  const skuBundleSignal = BUNDLE_SIGNALS.find((signal) => containsPhrase(skuText, signal));
  if (skuBundleSignal) {
    return { category: "BUNDLE", reason: `具体SKU包含套装信号“${skuBundleSignal}”` };
  }

  const skuBareSignal = BARE_SIGNALS.find((signal) => containsPhrase(skuText, signal));
  if (skuBareSignal) {
    return { category: "BARE", reason: `具体SKU包含裸机信号“${skuBareSignal}”` };
  }

  const titleBundleSignal = BUNDLE_SIGNALS.find((signal) => containsPhrase(offer.title, signal));
  if (titleBundleSignal) {
    return { category: "BUNDLE", reason: `商品标题包含套装信号“${titleBundleSignal}”` };
  }

  const titleBareSignal = BARE_SIGNALS.find((signal) => containsPhrase(offer.title, signal));
  if (titleBareSignal) {
    return { category: "BARE", reason: `商品标题包含裸机信号“${titleBareSignal}”` };
  }

  return { category: "MANUAL", reason: "无法可靠判断裸机或套装，进入人工分类" };
}

function rejected(reason: string): MatchDecision {
  return {
    category: "REJECTED",
    comparable: false,
    confidence: 1,
    reasons: [reason],
    normalizedModel: null
  };
}

export class MatcherService {
  match(rule: MonitoredProductRule, offer: RawOffer): MatchDecision {
    const skuText = selectedSkuText(offer);
    const searchable = `${offer.title} ${skuText}`;

    const excludedTerm = rule.excludedTerms.find((term) => containsPhrase(searchable, term));
    if (excludedTerm) {
      return rejected(`命中排除词“${excludedTerm}”`);
    }

    const excludedAlias = rule.excludedAliases.find((alias) => containsPhrase(searchable, alias));
    if (excludedAlias) {
      return rejected(`命中排除别名“${excludedAlias}”`);
    }

    const missingRequired = rule.mustIncludeTerms.filter((term) => !containsPhrase(searchable, term));
    if (missingRequired.length > 0) {
      return rejected(`缺少必须包含词：${missingRequired.join("、")}`);
    }

    const exactModel = containsPhrase(searchable, rule.standardModel);
    const matchedAlias = exactModel
      ? undefined
      : rule.effectiveAliases.find((alias) => containsPhrase(searchable, alias));
    if (!exactModel && !matchedAlias) {
      return rejected(`未识别到完整标准型号“${rule.standardModel}”，可能是旧款或其他型号`);
    }

    const reasons = [exactModel
      ? `命中标准型号“${rule.standardModel}”`
      : `命中有效别名“${matchedAlias}”`];
    const classification = classifyOffer(offer);
    reasons.push(classification.reason);

    if (classification.category === "MANUAL") {
      return {
        category: "MANUAL",
        comparable: false,
        confidence: exactModel ? 0.75 : 0.65,
        reasons,
        normalizedModel: rule.standardModel
      };
    }

    if (classification.category !== rule.comparisonType) {
      reasons.push(
        `当前监控要求${rule.comparisonType === "BARE" ? "裸机" : "套装"}，候选商品识别为${classification.category === "BARE" ? "裸机" : "套装"}，分池展示但不直接比较`
      );
      return {
        category: classification.category,
        comparable: false,
        confidence: exactModel ? 0.95 : 0.85,
        reasons,
        normalizedModel: rule.standardModel
      };
    }

    const brandMatched = containsPhrase(searchable, rule.brand);
    reasons.push(brandMatched ? `命中品牌“${rule.brand}”` : `标题未明确出现品牌“${rule.brand}”，已由型号规则识别`);
    return {
      category: classification.category,
      comparable: true,
      confidence: exactModel ? (brandMatched ? 0.98 : 0.93) : (brandMatched ? 0.9 : 0.85),
      reasons,
      normalizedModel: rule.standardModel
    };
  }
}
