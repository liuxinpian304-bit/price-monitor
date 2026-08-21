import { createHash } from "node:crypto";

export function dedupKey(
  competitorItemId: string,
  competitorSkuId: string,
  competitorPriceFen: number
): string {
  if (!Number.isSafeInteger(competitorPriceFen) || competitorPriceFen < 0) {
    throw new TypeError("同行价格必须是非负整数分");
  }
  const canonical = JSON.stringify({ competitorItemId, competitorSkuId, competitorPriceFen });
  return `price-v1:${createHash("sha256").update(canonical).digest("hex")}`;
}
