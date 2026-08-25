import type { PromotionEvidence } from "@stau-price-monitor/contracts";

import { UiContractChangedError, type DriverSkuView } from "../../core/desktop-driver.ts";
import { axNodeText, findAxNode, type AxNode } from "./ax-node.ts";

export interface SelectedSkuEvidence {
  listPriceText: string;
  listPriceFen: number;
  activityPriceText: string;
  activityPriceFen: number;
  officialEstimatedPayablePriceText: string | null;
  mandatoryFeeText: string;
  stockState: DriverSkuView["stockState"];
  promotions: PromotionEvidence[];
  promotionTexts: string[];
}

function yuanToFen(value: string): number {
  const [whole = "0", decimal = ""] = value.split(".");
  const fen = Number(whole) * 100 + Number(decimal.padEnd(2, "0"));
  if (!Number.isSafeInteger(fen) || fen < 0) throw new TypeError("Price is outside the supported range");
  return fen;
}

export function yuanTextToFen(text: string): number {
  const matches = [...text.matchAll(/(?<![\d.])[¥￥]?\s*(\d+(?:\.\d{1,2})?)(?![\d.])/g)];
  if (matches.length !== 1 || !matches[0]?.[1]) {
    throw new TypeError(matches.length > 1 ? "Price must contain exactly one decimal yuan amount" : "Price must be valid decimal yuan");
  }
  return yuanToFen(matches[0][1]);
}

function audienceFor(label: string): string {
  if (/88\s*VIP/i.test(label)) return "88VIP";
  if (/红包/.test(label)) return "PERSONAL_RED_PACKET";
  if (/账号|账户|专享/.test(label)) return "ACCOUNT";
  if (/会员/.test(label)) return "MEMBER";
  return "PUBLIC";
}

function evidence(
  kind: string,
  label: string,
  amountFen: number | null,
  thresholdFen: number | null,
  audience: string,
  stackGroup: string | null
): PromotionEvidence {
  return {
    kind,
    label,
    amountFen,
    thresholdFen,
    audience,
    stackGroup,
    includedInActivityPrice: false,
    activityPriceInclusion: "UNKNOWN"
  };
}

function hasExtraNumericText(label: string, matched: string): boolean {
  const remainder = label.replace(matched, "").replace(/88\s*VIP/ig, "");
  return /\d/.test(remainder);
}

export function parsePromotionLabel(label: string, explicitStackGroup: string | null): PromotionEvidence | null {
  const normalized = label.trim().replace(/\s+/g, " ");
  if (!normalized) return null;
  const audience = audienceFor(normalized);

  const fullMatches = [...normalized.matchAll(/满\s*(\d+(?:\.\d{1,2})?)\s*减\s*(\d+(?:\.\d{1,2})?)/g)];
  if (fullMatches.length === 1 && fullMatches[0]?.[1] && fullMatches[0]?.[2]
    && !hasExtraNumericText(normalized, fullMatches[0][0])) {
    return evidence(
      /券/.test(normalized) ? "COUPON" : "FULL_REDUCTION",
      normalized,
      yuanToFen(fullMatches[0][2]),
      yuanToFen(fullMatches[0][1]),
      audience,
      explicitStackGroup
    );
  }

  const couponMatches = [...normalized.matchAll(/(?<![\d.])(\d+(?:\.\d{1,2})?)\s*元券(?!\d)/g)];
  if (couponMatches.length === 1 && couponMatches[0]?.[1]
    && !hasExtraNumericText(normalized, couponMatches[0][0])) {
    return evidence("COUPON", normalized, yuanToFen(couponMatches[0][1]), null, audience, explicitStackGroup);
  }

  const directMatches = [...normalized.matchAll(/立减\s*(\d+(?:\.\d{1,2})?)\s*元/g)];
  if (directMatches.length === 1 && directMatches[0]?.[1]
    && !hasExtraNumericText(normalized, directMatches[0][0])) {
    return evidence("DIRECT_DISCOUNT", normalized, yuanToFen(directMatches[0][1]), 0, audience, explicitStackGroup);
  }

  if (audience !== "PUBLIC") {
    return evidence("NON_PUBLIC_BENEFIT", normalized, null, null, audience, null);
  }
  return evidence("UNKNOWN_PUBLIC_PROMOTION", normalized, null, null, audience, null);
}

function directChild(parent: AxNode, identifier: string): AxNode | null {
  return parent.children.find((node) => node.identifier === identifier) ?? null;
}

function requiredText(node: AxNode | null, field: string): string {
  const text = node ? axNodeText(node) : null;
  if (!text) throw new UiContractChangedError(`Selected-SKU ${field} evidence is missing`);
  return text;
}

function amountText(text: string): string {
  const fen = yuanTextToFen(text);
  return (fen / 100).toFixed(2);
}

function stackGroupFor(node: AxNode): string | null {
  if (node.identifier === "shop-coupon") return "shop-coupon";
  if (node.identifier === "platform-full-reduction") return "platform-full-reduction";
  if (node.identifier === "direct-reduction") return "direct-reduction";
  return null;
}

export function readSelectedSkuEvidence(root: AxNode): SelectedSkuEvidence {
  const priceRegion = findAxNode(root, (node) => node.identifier === "selected-sku-price"
    && node.role === "AXGroup" && node.title === "已选规格价格");
  if (!priceRegion) throw new UiContractChangedError("Selected-SKU price region is missing");
  const listLabel = requiredText(directChild(priceRegion, "list-price"), "list price");
  const activityLabel = requiredText(directChild(priceRegion, "activity-price"), "activity price");
  if (!/原价/.test(listLabel) || !/(?:店铺优惠后|活动价|活动到手价)/.test(activityLabel)) {
    throw new UiContractChangedError("Selected-SKU price labels changed");
  }

  const promotionRegion = findAxNode(root, (node) => node.identifier === "selected-sku-promotions"
    && node.role === "AXGroup" && node.title === "已选规格优惠");
  const promotionTexts = promotionRegion?.children.map(axNodeText).filter((text): text is string => text !== null) ?? [];
  const promotions = promotionRegion?.children.flatMap((node) => {
    const text = axNodeText(node);
    if (!text) return [];
    const parsed = parsePromotionLabel(text, stackGroupFor(node));
    return parsed ? [parsed] : [];
  }) ?? [];
  const stockNode = directChild(priceRegion, "stock-state");
  const stockText = stockNode ? axNodeText(stockNode) : null;
  const stockState: DriverSkuView["stockState"] = stockText === "有货"
    ? "IN_STOCK" : stockText === "无货" ? "OUT_OF_STOCK" : "UNKNOWN";
  const estimated = directChild(priceRegion, "official-estimated-payable");
  const mandatoryFee = directChild(priceRegion, "mandatory-fee");

  return {
    listPriceText: amountText(listLabel),
    listPriceFen: yuanTextToFen(listLabel),
    activityPriceText: amountText(activityLabel),
    activityPriceFen: yuanTextToFen(activityLabel),
    officialEstimatedPayablePriceText: estimated ? amountText(requiredText(estimated, "estimated payable")) : null,
    mandatoryFeeText: mandatoryFee ? amountText(requiredText(mandatoryFee, "mandatory fee")) : "0.00",
    stockState,
    promotions,
    promotionTexts
  };
}
