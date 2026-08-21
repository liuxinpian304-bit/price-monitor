import { describe, expect, it } from "vitest";

import { toCatalogPayload } from "./catalog-model-form.ts";

describe("toCatalogPayload", () => {
  it("normalizes semicolon rules and clears a bare model bundle code", () => {
    expect(toCatalogPayload({
      monitorCode: " MON-0099 ",
      enabled: true,
      brand: " RME ",
      standardModel: " Babyface Pro FS ",
      category: "声卡",
      searchQuery: "RME Babyface Pro FS",
      version: "",
      mustIncludeTerms: "Babyface; FS；Babyface",
      excludedTerms: "二手; 维修",
      ownUrl: "https://detail.tmall.com/item.htm?id=99",
      ownSkuText: "Babyface Pro FS单机",
      comparisonType: "BARE",
      bundleCode: "SHOULD-CLEAR",
      colorComparable: false,
      owner: "张三",
      notes: ""
    })).toMatchObject({
      monitorCode: "MON-0099",
      brand: "RME",
      version: null,
      mustIncludeTerms: ["Babyface", "FS"],
      excludedTerms: ["二手", "维修"],
      comparisonType: "BARE",
      bundleCode: null,
      notes: null
    });
  });
});
