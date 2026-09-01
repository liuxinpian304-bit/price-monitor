import { UiContractChangedError } from "../../core/desktop-driver.ts";
import { axNodeText, walkAxNodes, type AxNode } from "./ax-node.ts";
import { findLivePurchaseRegion } from "./taobao-live-selectors.ts";
import {
  parsePromotionLabel,
  yuanTextToFen,
  type SelectedSkuEvidence
} from "./taobao-price-evidence.ts";

interface LiveTextEvidence {
  text: string;
  labels: string[];
  subrole: string | null;
}

const ACTIVITY_PRICE_LABELS = ["活动价", "活动到手价", "店铺优惠后"];
const LIST_PRICE_LABELS = ["原价", "划线价"];
const ESTIMATED_PAYABLE_LABELS = ["预估到手价", "预计到手价"];
const SHIPPING_LABELS = ["运费"];
const IN_STOCK_TEXTS = new Set(["有货", "现货", "库存充足"]);
const OUT_OF_STOCK_TEXTS = new Set(["无货", "售罄", "缺货"]);
const SERVICE_COPY = /(?:运费险|保险|赔付)/;
const CONCRETE_PROMOTION = /^(?:(?:店铺券|平台满减|优惠券)\s*)?满\s*\d+(?:\.\d{1,2})?\s*减\s*\d+(?:\.\d{1,2})?(?:\s*元)?$|^(?:(?:店铺|平台)?优惠券?\s*)?\d+(?:\.\d{1,2})?\s*元券$|^(?:(?:店铺|平台)?优惠\s*)?立减\s*\d+(?:\.\d{1,2})?\s*元$/;
const CONCRETE_AUDIENCE_BENEFIT = /^(?:88\s*VIP\s*(?:专享|\d+(?:\.\d+)?折)|(?:该)?(?:账号|账户)\s*专享(?:\s*\d+(?:\.\d{1,2})?\s*元券)?|会员\s*专享|个人红包(?:\s*\d+(?:\.\d{1,2})?\s*元)?)$/i;
const UNKNOWN_ELIGIBILITY_PROMOTION = /^(?=.*(?:优惠|券|立减|折扣|抵扣|补贴|专享))(?=.*(?:新客|首单|资格|指定|部分用户|受邀)).+$/u;

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function liveTexts(root: AxNode): LiveTextEvidence[] {
  return walkAxNodes(root).flatMap((node) => {
    const text = axNodeText(node);
    if (!text) return [];
    return [{
      text: normalizeText(text),
      labels: [node.title, node.description].flatMap((label) => label ? [normalizeText(label)] : []),
      subrole: node.subrole
    }];
  });
}

function escapedPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasExactLabel(evidence: LiveTextEvidence, labels: string[]): boolean {
  return evidence.labels.some((label) => labels.includes(label));
}

function hasAnchoredLabelAndAmount(evidence: LiveTextEvidence, labels: string[]): boolean {
  return labels.some((label) => new RegExp(
    `^${escapedPattern(label)}\\s*(?:[:：]\\s*)?[¥￥]?\\s*\\d+(?:\\.\\d+)?\\s*$`
  ).test(evidence.text));
}

function isAmountOnly(text: string): boolean {
  return /^[¥￥]?\s*\d+(?:\.\d{1,2})?\s*$/.test(text);
}

function isSemanticAmountEvidence(evidence: LiveTextEvidence, labels: string[]): boolean {
  return hasAnchoredLabelAndAmount(evidence, labels)
    || (hasExactLabel(evidence, labels) && isAmountOnly(evidence.text));
}

function contractError(field: string): never {
  throw new UiContractChangedError(`Live selected-SKU ${field} evidence is ambiguous or missing`);
}

function requiredAmount(
  texts: LiveTextEvidence[],
  isCandidate: (evidence: LiveTextEvidence) => boolean,
  field: string
): number {
  const amounts = new Set(texts.filter(isCandidate).map((text) => yuanTextToFen(text.text)));
  if (amounts.size !== 1) return contractError(field);
  return amounts.values().next().value ?? contractError(field);
}

function optionalAmount(
  texts: LiveTextEvidence[],
  isCandidate: (evidence: LiveTextEvidence) => boolean,
  field: string
): number | null {
  const amounts = new Set(texts.filter(isCandidate).map((text) => yuanTextToFen(text.text)));
  if (amounts.size > 1) return contractError(field);
  return amounts.values().next().value ?? null;
}

function priceText(fen: number): string {
  return (fen / 100).toFixed(2);
}

function stockState(texts: LiveTextEvidence[]): SelectedSkuEvidence["stockState"] {
  const states = new Set<SelectedSkuEvidence["stockState"]>();
  for (const evidence of texts) {
    if (IN_STOCK_TEXTS.has(evidence.text)) states.add("IN_STOCK");
    if (OUT_OF_STOCK_TEXTS.has(evidence.text)) states.add("OUT_OF_STOCK");
  }
  if (states.size > 1) return contractError("stock state");
  return states.values().next().value ?? "UNKNOWN";
}

function isPromotionText(evidence: LiveTextEvidence): boolean {
  if (isSemanticAmountEvidence(evidence, ACTIVITY_PRICE_LABELS)
    || isSemanticAmountEvidence(evidence, LIST_PRICE_LABELS)
    || isSemanticAmountEvidence(evidence, ESTIMATED_PAYABLE_LABELS)
    || isSemanticAmountEvidence(evidence, SHIPPING_LABELS)) return false;
  return CONCRETE_PROMOTION.test(evidence.text)
    || CONCRETE_AUDIENCE_BENEFIT.test(evidence.text)
    || UNKNOWN_ELIGIBILITY_PROMOTION.test(evidence.text);
}

function promotionEvidence(texts: LiveTextEvidence[]): Pick<SelectedSkuEvidence, "promotions" | "promotionTexts"> {
  const promotionTexts = [...new Set(texts.filter(isPromotionText).map((text) => text.text))];
  const promotions = promotionTexts.flatMap((text) => {
    const promotion = parsePromotionLabel(text, null);
    return promotion ? [promotion] : [];
  });
  return { promotions, promotionTexts };
}

function mandatoryFeeFen(texts: LiveTextEvidence[]): number {
  const amounts = new Set<number>();
  for (const evidence of texts) {
    if (SERVICE_COPY.test(evidence.text) || evidence.labels.some((label) => SERVICE_COPY.test(label))) continue;
    if (evidence.text === "包邮" || evidence.labels.includes("包邮")) {
      amounts.add(0);
      continue;
    }
    if (isSemanticAmountEvidence(evidence, SHIPPING_LABELS)) {
      amounts.add(yuanTextToFen(evidence.text));
    }
  }
  if (amounts.size !== 1) return contractError("mandatory fee");
  return amounts.values().next().value ?? contractError("mandatory fee");
}

export function readLiveSelectedSkuEvidence(root: AxNode): SelectedSkuEvidence {
  const texts = liveTexts(findLivePurchaseRegion(root));
  const activityPriceFen = requiredAmount(
    texts,
    (evidence) => isSemanticAmountEvidence(evidence, ACTIVITY_PRICE_LABELS),
    "activity price"
  );
  const listPriceFen = optionalAmount(
    texts,
    (evidence) => isSemanticAmountEvidence(evidence, LIST_PRICE_LABELS)
      || (evidence.subrole === "AXStrikethrough" && isAmountOnly(evidence.text)),
    "list price"
  ) ?? activityPriceFen;
  const estimatedPayableFen = optionalAmount(
    texts,
    (evidence) => isSemanticAmountEvidence(evidence, ESTIMATED_PAYABLE_LABELS),
    "estimated payable"
  );
  const mandatoryFee = mandatoryFeeFen(texts);

  return {
    listPriceText: priceText(listPriceFen),
    listPriceFen,
    activityPriceText: priceText(activityPriceFen),
    activityPriceFen,
    officialEstimatedPayablePriceText: estimatedPayableFen === null ? null : priceText(estimatedPayableFen),
    mandatoryFeeText: priceText(mandatoryFee),
    stockState: stockState(texts),
    ...promotionEvidence(texts)
  };
}
