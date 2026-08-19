import type { CatalogModel } from "../../api/types.ts";

export interface CatalogFormValues {
  monitorCode: string;
  enabled: boolean;
  brand: string;
  standardModel: string;
  category: string;
  searchQuery: string;
  version: string;
  mustIncludeTerms: string;
  excludedTerms: string;
  ownUrl: string;
  ownSkuText: string;
  comparisonType: "BARE" | "BUNDLE";
  bundleCode: string;
  colorComparable: boolean;
  owner: string;
  notes: string;
}

function optionalText(value: string): string | null {
  const normalized = value.trim();
  return normalized === "" ? null : normalized;
}

function terms(value: string): string[] {
  return [...new Set(value
    .split(/[;；]/)
    .map((item) => item.trim())
    .filter(Boolean))];
}

export function toCatalogPayload(values: CatalogFormValues) {
  return {
    monitorCode: values.monitorCode.trim(),
    enabled: values.enabled,
    brand: values.brand.trim(),
    standardModel: values.standardModel.trim(),
    category: values.category.trim(),
    searchQuery: values.searchQuery.trim(),
    version: optionalText(values.version),
    mustIncludeTerms: terms(values.mustIncludeTerms),
    excludedTerms: terms(values.excludedTerms),
    ownUrl: values.ownUrl.trim(),
    ownSkuText: values.ownSkuText.trim(),
    comparisonType: values.comparisonType,
    bundleCode: values.comparisonType === "BARE" ? null : optionalText(values.bundleCode),
    colorComparable: values.colorComparable,
    owner: values.owner.trim(),
    notes: optionalText(values.notes)
  };
}

export function catalogFormValues(model: CatalogModel | null): CatalogFormValues {
  return model ? {
    monitorCode: model.monitorCode,
    enabled: model.enabled,
    brand: model.brand,
    standardModel: model.standardModel,
    category: model.category,
    searchQuery: model.searchQuery,
    version: model.version ?? "",
    mustIncludeTerms: model.mustIncludeTerms.join(";"),
    excludedTerms: model.excludedTerms.join(";"),
    ownUrl: model.ownUrl,
    ownSkuText: model.ownSkuText,
    comparisonType: model.comparisonType,
    bundleCode: model.bundleCode ?? "",
    colorComparable: model.colorComparable,
    owner: model.owner,
    notes: model.notes ?? ""
  } : {
    monitorCode: "",
    enabled: true,
    brand: "",
    standardModel: "",
    category: "声卡",
    searchQuery: "",
    version: "",
    mustIncludeTerms: "",
    excludedTerms: "二手;租赁;定金;维修",
    ownUrl: "",
    ownSkuText: "",
    comparisonType: "BARE",
    bundleCode: "",
    colorComparable: false,
    owner: "",
    notes: ""
  };
}
