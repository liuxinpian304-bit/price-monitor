import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ExcelJS, { type CellValue } from "exceljs";

import {
  CatalogImportService,
  type CatalogImportWriter,
  type ValidatedCatalogImport
} from "./catalog-import.service.ts";

const MODEL_HEADERS = [
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
];

const BUNDLE_HEADERS = [
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
];

const ALIAS_HEADERS = ["品牌", "标准型号", "常见写法", "匹配类型", "备注"];

type WorkbookRows = {
  models?: CellValue[][];
  bundles?: CellValue[][];
  aliases?: CellValue[][];
  modelHeaders?: string[];
};

async function createWorkbookBuffer(overrides: WorkbookRows = {}): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const modelSheet = workbook.addWorksheet("监控型号");
  const bundleSheet = workbook.addWorksheet("套装明细");
  const aliasSheet = workbook.addWorksheet("型号别名");
  workbook.addWorksheet("填写说明");

  modelSheet.getRow(4).values = overrides.modelHeaders ?? MODEL_HEADERS;
  bundleSheet.getRow(4).values = BUNDLE_HEADERS;
  aliasSheet.getRow(4).values = ALIAS_HEADERS;

  const models = overrides.models ?? [
    [
      "MON-0001",
      "是",
      "RME",
      "Babyface Pro FS",
      "声卡",
      "RME Babyface Pro FS",
      "FS新版",
      "Babyface;FS",
      "二手;租赁",
      "https://detail.tmall.com/item.htm?id=1001",
      "Babyface Pro FS单机",
      "裸机",
      "",
      "否",
      "张三",
      ""
    ],
    [
      "MON-0002",
      "是",
      "RME",
      "Babyface Pro FS",
      "声卡",
      "RME Babyface Pro FS 套装",
      "FS新版",
      "Babyface;FS",
      "二手;租赁",
      "https://detail.tmall.com/item.htm?id=1002",
      "Babyface Pro FS+MK4套装",
      "套装",
      "PKG-RME-001",
      "否",
      "李四",
      ""
    ]
  ];

  const bundles = overrides.bundles ?? [
    ["PKG-RME-001", "RME", "Babyface Pro FS", "麦克风", "Sennheiser", "MK4", 1, 1800, "是", ""]
  ];

  const aliases = overrides.aliases ?? [
    ["RME", "Babyface Pro FS", "娃娃脸FS", "有效别名", "国内常用简称"]
  ];

  models.forEach((row, index) => {
    modelSheet.getRow(index + 5).values = row;
  });
  bundles.forEach((row, index) => {
    bundleSheet.getRow(index + 5).values = row;
  });
  aliases.forEach((row, index) => {
    aliasSheet.getRow(index + 5).values = row;
  });

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

class RecordingWriter implements CatalogImportWriter {
  calls: Array<{ catalog: ValidatedCatalogImport; actorId: string }> = [];

  async importAtomically(catalog: ValidatedCatalogImport, actorId: string) {
    this.calls.push({ catalog, actorId });
    return { imported: catalog.models.length, updated: 0 };
  }
}

test("imports a valid four-sheet workbook atomically", async () => {
  const writer = new RecordingWriter();
  const service = new CatalogImportService(writer);

  const result = await service.importWorkbook(await createWorkbookBuffer(), "operator-1");

  assert.deepEqual(result, { imported: 2, updated: 0, errors: [] });
  assert.equal(writer.calls.length, 1);
  assert.equal(writer.calls[0]?.actorId, "operator-1");
  assert.equal(writer.calls[0]?.catalog.models[0]?.ownListing.shopName, "星空乐器专营店");
  assert.equal(writer.calls[0]?.catalog.bundles[0]?.items[0]?.unitValueFen, 180_000);
  assert.deepEqual(writer.calls[0]?.catalog.models[0]?.mustIncludeTerms, ["Babyface", "FS"]);
});

test("reports both duplicate monitor code rows and does not write", async () => {
  const writer = new RecordingWriter();
  const service = new CatalogImportService(writer);
  const models = [
    ["MON-0001", "是", "RME", "Babyface Pro FS", "声卡", "RME Babyface Pro FS", "", "", "", "https://detail.tmall.com/1", "单机", "裸机", "", "否", "张三", ""],
    ["MON-0001", "是", "RME", "Fireface UCX II", "声卡", "RME Fireface UCX II", "", "", "", "https://detail.tmall.com/2", "单机", "裸机", "", "否", "张三", ""]
  ];

  const result = await service.importWorkbook(
    await createWorkbookBuffer({ models, bundles: [], aliases: [] }),
    "operator-1"
  );

  assert.equal(writer.calls.length, 0);
  assert.deepEqual(
    result.errors.filter((error) => error.field === "监控编号").map((error) => error.row),
    [5, 6]
  );
});

test("reports a bundle model that has no bundle details", async () => {
  const writer = new RecordingWriter();
  const service = new CatalogImportService(writer);

  const result = await service.importWorkbook(
    await createWorkbookBuffer({ bundles: [] }),
    "operator-1"
  );

  assert.equal(writer.calls.length, 0);
  assert.ok(result.errors.some((error) =>
    error.sheet === "监控型号" &&
    error.row === 6 &&
    error.field === "套装编号" &&
    error.message.includes("套装明细")
  ));
});

test("reports an invalid comparison type at its exact cell", async () => {
  const writer = new RecordingWriter();
  const service = new CatalogImportService(writer);
  const models = [[
    "MON-0001", "是", "RME", "Babyface Pro FS", "声卡", "RME Babyface Pro FS", "", "", "",
    "https://detail.tmall.com/1", "单机", "组合", "", "否", "张三", ""
  ]];

  const result = await service.importWorkbook(
    await createWorkbookBuffer({ models, bundles: [], aliases: [] }),
    "operator-1"
  );

  assert.ok(result.errors.some((error) =>
    error.sheet === "监控型号" && error.row === 5 && error.field === "比价类型"
  ));
});

test("reports an alias that references a model absent from the model sheet", async () => {
  const writer = new RecordingWriter();
  const service = new CatalogImportService(writer);
  const aliases = [["RME", "Fireface 802 FS", "802FS", "有效别名", ""]];

  const result = await service.importWorkbook(
    await createWorkbookBuffer({ aliases }),
    "operator-1"
  );

  assert.ok(result.errors.some((error) =>
    error.sheet === "型号别名" &&
    error.row === 5 &&
    error.field === "标准型号" &&
    error.message.includes("监控型号")
  ));
});

test("reports a missing required header before reading rows", async () => {
  const writer = new RecordingWriter();
  const service = new CatalogImportService(writer);

  const result = await service.importWorkbook(
    await createWorkbookBuffer({ modelHeaders: MODEL_HEADERS.filter((header) => header !== "负责人") }),
    "operator-1"
  );

  assert.equal(writer.calls.length, 0);
  assert.ok(result.errors.some((error) =>
    error.sheet === "监控型号" && error.row === 4 && error.field === "负责人"
  ));
});

test("recognizes the distributed operations template as a valid workbook", async () => {
  const writer = new RecordingWriter();
  const service = new CatalogImportService(writer);
  const template = await readFile(new URL(
    "../../../../../outputs/tmall-price-monitor/天猫比价监控_运营录入模板.xlsx",
    import.meta.url
  ));

  const result = await service.importWorkbook(template, "operator-1");

  assert.deepEqual(result.errors, []);
  assert.equal(writer.calls.length, 1);
});
