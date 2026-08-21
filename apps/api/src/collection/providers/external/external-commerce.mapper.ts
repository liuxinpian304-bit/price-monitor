import { z } from "zod";

import { moneyFromYuan } from "../../../../../../packages/config/src/money.ts";
import {
  OfferUnavailableError,
  ProviderContractChangedError,
  ProviderRateLimitedError,
  type RawOffer,
  type SearchHit,
  type StockState
} from "../commerce-provider.ts";

const yuan = z.string().regex(/^(0|[1-9]\d*)(?:\.\d{1,2})?$/);
const httpUrl = z.string().url().refine((value) => value.startsWith("http://") || value.startsWith("https://"));

const statusSchema = z.object({
  status: z.string(),
  message: z.string().optional(),
  retry_after_seconds: z.number().int().nonnegative().optional()
});

const searchSchema = z.object({
  status: z.literal("ok"),
  data: z.object({
    items: z.array(z.object({
      item_id: z.string().min(1),
      url: httpUrl,
      shop_name: z.string().min(1),
      title: z.string().min(1),
      price_range: z.object({
        min_yuan: yuan,
        max_yuan: yuan
      }).nullable().optional()
    }))
  })
});

const offerSchema = z.object({
  status: z.literal("ok"),
  data: z.object({
    item_id: z.string().min(1),
    url: httpUrl,
    shop_name: z.string().min(1),
    title: z.string().min(1),
    selected_sku_id: z.string().min(1),
    sku_options: z.array(z.object({
      sku_id: z.string().min(1),
      label: z.string().min(1),
      attributes: z.record(z.string(), z.string()),
      list_price_yuan: yuan,
      public_discount_yuan: yuan,
      payable_yuan: yuan,
      stock: z.enum(["in_stock", "out_of_stock", "unknown"])
    })).min(1),
    promotions: z.array(z.object({
      type: z.string().min(1),
      label: z.string().min(1),
      amount_yuan: yuan.nullable().optional()
    })).default([]),
    gifts: z.array(z.object({
      name: z.string().min(1),
      quantity: z.number().int().positive()
    })).default([]),
    captured_at: z.string().datetime({ offset: true }),
    evidence_url: httpUrl.nullable().optional()
  })
});

function checkStatus(payload: unknown): void {
  const status = statusSchema.safeParse(payload);
  if (!status.success) {
    throw new ProviderContractChangedError("供应商响应缺少有效的 status 字段");
  }

  if (status.data.status === "rate_limited") {
    throw new ProviderRateLimitedError(
      status.data.message ?? "供应商请求已限流",
      status.data.retry_after_seconds ?? null
    );
  }

  if (status.data.status === "unavailable") {
    throw new OfferUnavailableError(status.data.message ?? "商品当前不可用");
  }

  if (status.data.status !== "ok") {
    throw new ProviderContractChangedError(`无法识别的供应商状态：${status.data.status}`);
  }
}

function contractError(context: string, error: z.ZodError): ProviderContractChangedError {
  const fields = error.issues.map((issue) => issue.path.join(".") || "root").join(", ");
  return new ProviderContractChangedError(`${context}字段缺失或类型变化：${fields}`);
}

function mapStock(stock: "in_stock" | "out_of_stock" | "unknown"): StockState {
  if (stock === "in_stock") return "IN_STOCK";
  if (stock === "out_of_stock") return "OUT_OF_STOCK";
  return "UNKNOWN";
}

export function mapExternalSearch(payload: unknown): SearchHit[] {
  checkStatus(payload);
  const parsed = searchSchema.safeParse(payload);
  if (!parsed.success) {
    throw contractError("搜索结果", parsed.error);
  }

  return parsed.data.data.items.map((item) => ({
    platformItemId: item.item_id,
    url: item.url,
    shopName: item.shop_name,
    title: item.title,
    displayPriceRangeFen: item.price_range
      ? {
          minFen: moneyFromYuan(item.price_range.min_yuan),
          maxFen: moneyFromYuan(item.price_range.max_yuan)
        }
      : null
  }));
}

export function mapExternalOffer(payload: unknown): RawOffer {
  checkStatus(payload);
  const parsed = offerSchema.safeParse(payload);
  if (!parsed.success) {
    throw contractError("商品详情", parsed.error);
  }

  const data = parsed.data.data;
  const skuOptions = data.sku_options.map((sku) => ({
    skuId: sku.sku_id,
    label: sku.label,
    attributes: sku.attributes,
    listPriceFen: moneyFromYuan(sku.list_price_yuan),
    publicDiscountFen: moneyFromYuan(sku.public_discount_yuan),
    payableFen: moneyFromYuan(sku.payable_yuan),
    stockState: mapStock(sku.stock)
  }));
  const selected = skuOptions.find((sku) => sku.skuId === data.selected_sku_id);
  if (!selected) {
    throw new ProviderContractChangedError("商品详情中的 selected_sku_id 未出现在 sku_options 中");
  }

  return {
    platformItemId: data.item_id,
    url: data.url,
    shopName: data.shop_name,
    title: data.title,
    selectedSkuId: selected.skuId,
    skuOptions,
    listPriceFen: selected.listPriceFen,
    publicDiscountFen: selected.publicDiscountFen,
    payableFen: selected.payableFen,
    promotions: data.promotions.map((promotion) => ({
      type: promotion.type,
      label: promotion.label,
      amountFen: promotion.amount_yuan === null || promotion.amount_yuan === undefined
        ? null
        : moneyFromYuan(promotion.amount_yuan)
    })),
    gifts: data.gifts,
    stockState: selected.stockState,
    capturedAt: new Date(data.captured_at),
    evidenceUrl: data.evidence_url ?? null,
    rawEvidence: payload
  };
}
