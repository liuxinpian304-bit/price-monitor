import { createHash } from "node:crypto";

export function dedupKey(
  monitoredModelId: string,
  ownSkuId: string,
  competitorItemId: string,
  competitorSkuId: string,
  competitorPriceFen: number
): string {
  if (!Number.isSafeInteger(competitorPriceFen) || competitorPriceFen < 0) {
    throw new TypeError("同行价格必须是非负整数分");
  }
  const canonical = JSON.stringify({
    monitoredModelId,
    ownSkuId,
    competitorItemId,
    competitorSkuId,
    competitorPriceFen
  });
  return `price-v2:${createHash("sha256").update(canonical).digest("hex")}`;
}
