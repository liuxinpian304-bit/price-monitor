import { z } from "zod";

const nullableText = z.string().trim().min(1).nullable();
const httpUrl = z.string().trim().min(1).refine((value) => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}, "我方商品链接必须是有效的 HTTP 或 HTTPS 地址");

const baseCatalogModelSchema = z.object({
  monitorCode: z.string().trim().min(1, "监控编号不能为空").max(50),
  enabled: z.boolean(),
  brand: z.string().trim().min(1, "品牌不能为空").max(120),
  standardModel: z.string().trim().min(1, "标准型号不能为空").max(200),
  category: z.string().trim().min(1, "类目不能为空").max(120),
  searchQuery: z.string().trim().min(1, "搜索关键词不能为空").max(500),
  version: nullableText,
  mustIncludeTerms: z.array(z.string().trim().min(1)).default([]),
  excludedTerms: z.array(z.string().trim().min(1)).default([]),
  ownUrl: httpUrl,
  ownSkuText: z.string().trim().min(1, "我方SKU规格不能为空").max(500),
  comparisonType: z.enum(["BARE", "BUNDLE"]),
  bundleCode: nullableText,
  colorComparable: z.boolean(),
  owner: z.string().trim().min(1, "负责人不能为空").max(120),
  notes: z.string().trim().nullable()
});

export const catalogModelSchema = baseCatalogModelSchema.superRefine((model, context) => {
  if (model.comparisonType === "BARE" && model.bundleCode !== null) {
    context.addIssue({
      code: "custom",
      path: ["bundleCode"],
      message: "裸机的套装编号必须留空"
    });
  }

  if (model.comparisonType === "BUNDLE" && model.bundleCode === null) {
    context.addIssue({
      code: "custom",
      path: ["bundleCode"],
      message: "套装必须填写套装编号"
    });
  }
});

export const updateCatalogModelSchema = baseCatalogModelSchema.partial().refine(
  (input) => Object.keys(input).length > 0,
  "至少需要修改一个字段"
);

export type CreateCatalogModelInput = z.input<typeof catalogModelSchema>;
export type ValidatedCatalogModelInput = z.output<typeof catalogModelSchema>;
export type UpdateCatalogModelInput = z.input<typeof updateCatalogModelSchema>;
