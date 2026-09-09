import { UiContractChangedError } from "../../core/desktop-driver.ts";
import { axNodeText, hasDomClassPrefix, walkAxNodes, type AxNode } from "./ax-node.ts";
import {
  readLiveDomUndiscountedPriceText,
  resolveLivePurchaseRegion
} from "./taobao-live-selectors.ts";
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
const DOM_LIST_PRICE_LABELS = ["优惠前", ...LIST_PRICE_LABELS];
const DOM_PRICE_LABELS = [...ACTIVITY_PRICE_LABELS, ...DOM_LIST_PRICE_LABELS];
const DOM_PRICE_CLASS_PREFIXES = ["price--", "priceWrap--"] as const;
const DOM_ENJOYED_PROMOTION_CLASS_PREFIX = "couponInfoArea--";
const ENJOYED_PROMOTION_LABELS = new Set(["已享受:", "已享受："]);
const ESTIMATED_PAYABLE_LABELS = ["预估到手价", "预计到手价"];
const SHIPPING_LABELS = ["运费"];
const IN_STOCK_TEXTS = new Set(["有货", "现货", "库存充足", "即将售罄"]);
const OUT_OF_STOCK_TEXTS = new Set(["无货", "售罄", "缺货"]);
const SERVICE_COPY = /(?:运费险|保险|赔付)/;
const ZERO_SHIPPING_COPY = /^(?:包邮|免运费|(?:快递|运费)\s*[:：]\s*(?:免运费|包邮))$/;
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

function promotionEvidence(
  texts: LiveTextEvidence[],
  includedPromotionTexts: ReadonlySet<string> = new Set()
): Pick<SelectedSkuEvidence, "promotions" | "promotionTexts"> {
  const promotionTexts = [...new Set(texts.filter(isPromotionText).map((text) => text.text))];
  const promotions = promotionTexts.flatMap((text) => {
    const promotion = parsePromotionLabel(text, null);
    if (!promotion) return [];
    return includedPromotionTexts.has(text)
      ? [{ ...promotion, includedInActivityPrice: true, activityPriceInclusion: "INCLUDED" as const }]
      : [promotion];
  });
  return { promotions, promotionTexts };
}

function exactTextCount(root: AxNode, expected: string): number {
  return walkAxNodes(root).filter((node) => exactNodeText(node) === expected).length;
}

function includedDomPromotionTexts(
  purchaseRegion: AxNode,
  priceRegion: AxNode,
  listPriceFen: number,
  activityPriceFen: number
): ReadonlySet<string> {
  if (listPriceFen < activityPriceFen
    || exactTextCount(priceRegion, "店铺优惠后") !== 1
    || exactTextCount(priceRegion, "优惠前") !== 1) return new Set();

  const areas = walkAxNodes(purchaseRegion).filter((node) =>
    hasDomClassPrefix(node, DOM_ENJOYED_PROMOTION_CLASS_PREFIX));
  if (areas.length !== 1) return new Set();
  const area = areas[0] ?? contractError("enjoyed promotion region");
  if (walkAxNodes(area).filter((node) => {
    const text = exactNodeText(node);
    return text !== null && ENJOYED_PROMOTION_LABELS.has(text);
  }).length !== 1) return new Set();

  const texts = [...new Set(liveTexts(area).filter(isPromotionText).map((entry) => entry.text))];
  const promotions = texts.map((text) => parsePromotionLabel(text, null));
  if (promotions.length === 0 || promotions.some((promotion) =>
    promotion === null || promotion.audience !== "PUBLIC" || promotion.amountFen === null)) {
    return new Set();
  }
  const includedAmountFen = promotions.reduce((total, promotion) => {
    const next = total + (promotion?.amountFen ?? 0);
    return Number.isSafeInteger(next) ? next : Number.NaN;
  }, 0);
  return includedAmountFen === listPriceFen - activityPriceFen ? new Set(texts) : new Set();
}

function mandatoryFeeFen(texts: LiveTextEvidence[]): number {
  const amounts = new Set<number>();
  for (const evidence of texts) {
    if (SERVICE_COPY.test(evidence.text) || evidence.labels.some((label) => SERVICE_COPY.test(label))) continue;
    if (ZERO_SHIPPING_COPY.test(evidence.text)
      || evidence.labels.some((label) => ZERO_SHIPPING_COPY.test(label))) {
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

function domPriceRegion(purchaseRegion: AxNode): AxNode | null {
  const regions = walkAxNodes(purchaseRegion).filter((node) =>
    DOM_PRICE_CLASS_PREFIXES.some((prefix) => hasDomClassPrefix(node, prefix)));
  if (regions.length > 1) return contractError("price region");
  return regions[0] ?? null;
}

function exactNodeText(node: AxNode): string | null {
  const text = axNodeText(node);
  return text ? normalizeText(text) : null;
}

function domLabeledPriceGroup(priceRegion: AxNode, labels: string[], field: string): AxNode | null {
  const groups = walkAxNodes(priceRegion).filter((node) => {
    if (node.role !== "AXGroup") return false;
    const explicitLabels = walkAxNodes(node).flatMap((candidate) => {
      const text = exactNodeText(candidate);
      return text !== null && DOM_PRICE_LABELS.includes(text) ? [text] : [];
    });
    return explicitLabels.length === 1 && labels.includes(explicitLabels[0] ?? "");
  });
  if (groups.length > 1) return contractError(field);
  return groups[0] ?? null;
}

function domAmountFromValues(values: string[], field: string): number {
  if (values.length === 1) return yuanTextToFen(values[0] ?? "");
  if (values.length === 2
    && (values[0] === "¥" || values[0] === "￥")) {
    return yuanTextToFen(values[1] ?? "");
  }
  if (values.length === 3
    && (values[0] === "¥" || values[0] === "￥")
    && /^(?:0|[1-9]\d{0,7})$/.test(values[1] ?? "")
    && /^\d{1,2}$/.test(values[2] ?? "")) {
    return yuanTextToFen(`${values[1]}.${values[2]?.padEnd(2, "0")}`);
  }
  return contractError(field);
}

function domGroupAmount(group: AxNode, field: string): number {
  const values = walkAxNodes(group).flatMap((node) => {
    const text = exactNodeText(node);
    return text !== null && !DOM_PRICE_LABELS.includes(text) ? [text] : [];
  });
  return domAmountFromValues(values, field);
}

function domFlatLabeledAmount(priceRegion: AxNode, labels: string[], field: string): number {
  const labeledChildren = priceRegion.children.flatMap((node, index) => {
    const text = exactNodeText(node);
    return text !== null && labels.includes(text) ? [{ index, text }] : [];
  });
  if (labeledChildren.length !== 1) return contractError(field);

  const labelIndex = labeledChildren[0]?.index ?? contractError(field);
  const nextLabelOffset = priceRegion.children.slice(labelIndex + 1).findIndex((node) => {
    const text = exactNodeText(node);
    return text !== null && DOM_PRICE_LABELS.includes(text);
  });
  const endIndex = nextLabelOffset === -1
    ? priceRegion.children.length
    : labelIndex + 1 + nextLabelOffset;
  const values = priceRegion.children.slice(labelIndex + 1, endIndex).flatMap((node) =>
    walkAxNodes(node).flatMap((candidate) => {
      const text = exactNodeText(candidate);
      return text !== null && !DOM_PRICE_LABELS.includes(text) ? [text] : [];
    }));
  return domAmountFromValues(values, field);
}

function domLabeledPriceAmount(priceRegion: AxNode, labels: string[], field: string): number {
  const group = domLabeledPriceGroup(priceRegion, labels, field);
  return group === null
    ? domFlatLabeledAmount(priceRegion, labels, field)
    : domGroupAmount(group, field);
}

function readDomSelectedSkuEvidence(purchaseRegion: AxNode, priceRegion: AxNode): SelectedSkuEvidence {
  const texts = liveTexts(purchaseRegion);
  const undiscountedPriceText = readLiveDomUndiscountedPriceText(priceRegion);
  const activityPriceFen = undiscountedPriceText === null
    ? domLabeledPriceAmount(priceRegion, ACTIVITY_PRICE_LABELS, "activity price")
    : yuanTextToFen(undiscountedPriceText);
  const listPriceFen = undiscountedPriceText === null
    ? domLabeledPriceAmount(priceRegion, DOM_LIST_PRICE_LABELS, "list price")
    : activityPriceFen;
  const mandatoryFee = mandatoryFeeFen(texts);

  return {
    listPriceText: priceText(listPriceFen),
    listPriceFen,
    activityPriceText: priceText(activityPriceFen),
    activityPriceFen,
    officialEstimatedPayablePriceText: null,
    mandatoryFeeText: priceText(mandatoryFee),
    stockState: stockState(texts),
    ...promotionEvidence(
      texts,
      includedDomPromotionTexts(purchaseRegion, priceRegion, listPriceFen, activityPriceFen)
    )
  };
}

export function readLiveSelectedSkuEvidence(root: AxNode): SelectedSkuEvidence {
  const purchase = resolveLivePurchaseRegion(root);
  const purchaseRegion = purchase.node;
  if (purchase.kind === "DOM") {
    const domRegion = domPriceRegion(purchaseRegion) ?? contractError("price region");
    return readDomSelectedSkuEvidence(purchaseRegion, domRegion);
  }

  const texts = liveTexts(purchaseRegion);
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
