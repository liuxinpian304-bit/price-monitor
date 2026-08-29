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
}

const ACTIVITY_PRICE_LABEL = /(?:活动价|活动到手价|店铺优惠后)/;
const LIST_PRICE_LABEL = /(?:原价|划线价)/;
const ESTIMATED_PAYABLE_LABEL = /(?:预估到手价|预计到手价)/;
const SHIPPING_LABEL = /运费/;
const IN_STOCK_TEXTS = new Set(["有货", "现货", "库存充足"]);
const OUT_OF_STOCK_TEXTS = new Set(["无货", "售罄", "缺货"]);

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function liveTexts(root: AxNode): LiveTextEvidence[] {
  return walkAxNodes(root).flatMap((node) => {
    const text = axNodeText(node);
    if (!text) return [];
    return [{
      text: normalizeText(text),
      labels: [node.title, node.description].flatMap((label) => label ? [normalizeText(label)] : [])
    }];
  });
}

function hasLabel(evidence: LiveTextEvidence, label: RegExp): boolean {
  return label.test(evidence.text) || evidence.labels.some((value) => label.test(value));
}

function contractError(field: string): never {
  throw new UiContractChangedError(`Live selected-SKU ${field} evidence is ambiguous or missing`);
}

function requiredAmount(texts: LiveTextEvidence[], label: RegExp, field: string): number {
  const amounts = new Set(texts.filter((text) => hasLabel(text, label)).map((text) => yuanTextToFen(text.text)));
  if (amounts.size !== 1) return contractError(field);
  return amounts.values().next().value ?? contractError(field);
}

function optionalAmount(texts: LiveTextEvidence[], label: RegExp, field: string): number | null {
  const amounts = new Set(texts.filter((text) => hasLabel(text, label)).map((text) => yuanTextToFen(text.text)));
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
  if (hasLabel(evidence, ACTIVITY_PRICE_LABEL) || hasLabel(evidence, LIST_PRICE_LABEL)
    || hasLabel(evidence, ESTIMATED_PAYABLE_LABEL) || hasLabel(evidence, SHIPPING_LABEL)) return false;
  return /(?:满\s*\d+(?:\.\d{1,2})?\s*减\s*\d+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?\s*元券|立减\s*\d+(?:\.\d{1,2})?\s*元|88\s*VIP|红包|专享|会员|优惠|促销)/i.test(evidence.text);
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
    if (/包邮/.test(evidence.text) || evidence.labels.some((label) => /包邮/.test(label))) amounts.add(0);
    if (hasLabel(evidence, SHIPPING_LABEL) && !/包邮/.test(evidence.text)) {
      amounts.add(yuanTextToFen(evidence.text));
    }
  }
  if (amounts.size > 1) return contractError("mandatory fee");
  return amounts.values().next().value ?? 0;
}

export function readLiveSelectedSkuEvidence(root: AxNode): SelectedSkuEvidence {
  const texts = liveTexts(findLivePurchaseRegion(root));
  const activityPriceFen = requiredAmount(texts, ACTIVITY_PRICE_LABEL, "activity price");
  const listPriceFen = optionalAmount(texts, LIST_PRICE_LABEL, "list price") ?? activityPriceFen;
  const estimatedPayableFen = optionalAmount(texts, ESTIMATED_PAYABLE_LABEL, "estimated payable");
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
