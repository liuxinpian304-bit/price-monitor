import { z } from "zod";

import { moneyFromYuan } from "../../../../../packages/config/src/money.ts";

const requiredText = (message = "不能为空") => z.string().trim().min(1, message);
const optionalText = z.string().trim().transform((value) => value === "" ? null : value);
const yesNo = z.enum(["是", "否"], { error: "仅允许填写“是”或“否”" })
  .transform((value) => value === "是");
const comparisonType = z.enum(["裸机", "套装"], { error: "仅允许填写“裸机”或“套装”" })
  .transform((value) => value === "裸机" ? "BARE" as const : "BUNDLE" as const);
const aliasType = z.enum(["有效别名", "排除别名"], { error: "仅允许填写“有效别名”或“排除别名”" })
  .transform((value) => value === "有效别名" ? "EFFECTIVE" as const : "EXCLUDED" as const);
const termList = z.string().trim().transform((value) => value === ""
  ? []
  : value.split(";").map((term) => term.trim()).filter(Boolean));
const positiveInteger = z.string().trim()
  .regex(/^[1-9]\d*$/, "必须是正整数")
  .transform(Number);
const yuanAmount = z.string().trim()
  .regex(/^(0|[1-9]\d*)(?:\.\d{1,2})?$/, "必须是最多两位小数的人民币金额")
  .transform(moneyFromYuan);
const httpUrl = requiredText().refine((value) => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}, "必须是有效的 HTTP 或 HTTPS 商品链接");

export const MODEL_HEADERS = [
  "监控编号",
  "是否启用",
  "品牌",
  "标准型号",
  "类目",
  "搜索关键词",
  "型号版本",
  "必须包含词",
  "排除词",
  "我方商品链接",
  "我方SKU规格",
  "比价类型",
  "套装编号",
  "颜色是否可互比",
  "负责人",
  "备注"
] as const;

export const BUNDLE_HEADERS = [
  "套装编号",
  "主产品品牌",
  "主产品型号",
  "配件类型",
  "配件品牌",
  "配件型号或名称",
  "数量",
  "单件标准价值",
  "是否核心配件",
  "备注"
] as const;

export const ALIAS_HEADERS = ["品牌", "标准型号", "常见写法", "匹配类型", "备注"] as const;

export const modelRowSchema = z.object({
  monitorCode: requiredText(),
  enabled: yesNo,
  brand: requiredText(),
  standardModel: requiredText(),
  category: requiredText(),
  searchQuery: requiredText(),
  version: optionalText,
  mustIncludeTerms: termList,
  excludedTerms: termList,
  ownUrl: httpUrl,
  ownSkuText: requiredText(),
  comparisonType,
  bundleCode: optionalText,
  colorComparable: yesNo,
  owner: requiredText(),
  notes: optionalText
}).superRefine((row, context) => {
  if (row.comparisonType === "BUNDLE" && row.bundleCode === null) {
    context.addIssue({
      code: "custom",
      path: ["bundleCode"],
      message: "比价类型为套装时必须填写套装编号"
    });
  }

  if (row.comparisonType === "BARE" && row.bundleCode !== null) {
    context.addIssue({
      code: "custom",
      path: ["bundleCode"],
      message: "比价类型为裸机时套装编号必须留空"
    });
  }
});

export const bundleRowSchema = z.object({
  bundleCode: requiredText(),
  mainBrand: requiredText(),
  mainModel: requiredText(),
  accessoryType: requiredText(),
  accessoryBrand: optionalText,
  modelOrName: requiredText(),
  quantity: positiveInteger,
  unitValueFen: yuanAmount,
  core: yesNo,
  notes: optionalText
});

export const aliasRowSchema = z.object({
  brand: requiredText(),
  standardModel: requiredText(),
  phrase: requiredText(),
  type: aliasType,
  notes: optionalText
});

export type ValidatedModelRow = z.infer<typeof modelRowSchema>;
export type ValidatedBundleRow = z.infer<typeof bundleRowSchema>;
export type ValidatedAliasRow = z.infer<typeof aliasRowSchema>;

export const MODEL_FIELD_LABELS: Record<keyof z.input<typeof modelRowSchema>, string> = {
  monitorCode: "监控编号",
  enabled: "是否启用",
  brand: "品牌",
  standardModel: "标准型号",
  category: "类目",
  searchQuery: "搜索关键词",
  version: "型号版本",
  mustIncludeTerms: "必须包含词",
  excludedTerms: "排除词",
  ownUrl: "我方商品链接",
  ownSkuText: "我方SKU规格",
  comparisonType: "比价类型",
  bundleCode: "套装编号",
  colorComparable: "颜色是否可互比",
  owner: "负责人",
  notes: "备注"
};

export const BUNDLE_FIELD_LABELS: Record<keyof z.input<typeof bundleRowSchema>, string> = {
  bundleCode: "套装编号",
  mainBrand: "主产品品牌",
  mainModel: "主产品型号",
  accessoryType: "配件类型",
  accessoryBrand: "配件品牌",
  modelOrName: "配件型号或名称",
  quantity: "数量",
  unitValueFen: "单件标准价值",
  core: "是否核心配件",
  notes: "备注"
};

export const ALIAS_FIELD_LABELS: Record<keyof z.input<typeof aliasRowSchema>, string> = {
  brand: "品牌",
  standardModel: "标准型号",
  phrase: "常见写法",
  type: "匹配类型",
  notes: "备注"
};
