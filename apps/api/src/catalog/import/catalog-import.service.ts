import ExcelJS from "exceljs";
import JSZip from "jszip";
import { posix } from "node:path";
import type { ZodIssue, ZodType } from "zod";

import {
  ALIAS_FIELD_LABELS,
  ALIAS_HEADERS,
  BUNDLE_FIELD_LABELS,
  BUNDLE_HEADERS,
  MODEL_FIELD_LABELS,
  MODEL_HEADERS,
  aliasRowSchema,
  bundleRowSchema,
  modelRowSchema,
  type ValidatedAliasRow,
  type ValidatedBundleRow,
  type ValidatedModelRow
} from "./catalog-import.schema.ts";

export interface ImportRowError {
  sheet: string;
  row: number;
  field: string;
  message: string;
}

export interface CatalogImportResult {
  imported: number;
  updated: number;
  errors: ImportRowError[];
}

export interface ValidatedModelImport extends ValidatedModelRow {
  sourceRow: number;
  ownListing: {
    platform: "TMALL";
    shopName: "星空乐器专营店";
    url: string;
    skuText: string;
  };
}

export interface ValidatedBundleImport {
  code: string;
  mainBrand: string;
  mainModel: string;
  items: Array<ValidatedBundleRow & { sourceRow: number }>;
}

export interface ValidatedAliasImport extends ValidatedAliasRow {
  sourceRow: number;
}

export interface ValidatedCatalogImport {
  models: ValidatedModelImport[];
  bundles: ValidatedBundleImport[];
  aliases: ValidatedAliasImport[];
}

export interface CatalogImportWriter {
  importAtomically(
    catalog: ValidatedCatalogImport,
    actorId: string
  ): Promise<{ imported: number; updated: number }>;
}

interface ParsedRow<T> {
  value: T;
  sourceRow: number;
}

type FieldLabels<T> = Record<keyof T, string>;

const HEADER_ROW = 4;
const FIRST_DATA_ROW = 5;
const SPREADSHEET_NAMESPACE = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";

function relationshipSourceDirectory(path: string): string {
  if (path === "_rels/.rels") {
    return "";
  }
  const marker = "/_rels/";
  const markerIndex = path.indexOf(marker);
  return markerIndex === -1 ? "" : path.slice(0, markerIndex);
}

function normalizeRelationshipTargets(xml: string, relationshipPath: string): string {
  const sourceDirectory = relationshipSourceDirectory(relationshipPath);
  return xml.replace(/Target=(["'])\/([^"']+)\1/g, (_match, quote: string, target: string) => {
    const relativeTarget = posix.relative(sourceDirectory, target);
    return `Target=${quote}${relativeTarget}${quote}`;
  });
}

async function normalizeArtifactToolWorkbook(buffer: Buffer): Promise<Buffer | null> {
  const archive = await JSZip.loadAsync(buffer);
  let changed = false;

  for (const [path, file] of Object.entries(archive.files)) {
    if (file.dir || (!path.endsWith(".xml") && !path.endsWith(".rels"))) {
      continue;
    }

    const original = await file.async("string");
    let normalized = original;
    if (path.endsWith(".xml") && original.includes("<x:")) {
      normalized = normalized
        .replace(`xmlns:x="${SPREADSHEET_NAMESPACE}"`, `xmlns="${SPREADSHEET_NAMESPACE}"`)
        .replace(`xmlns:x='${SPREADSHEET_NAMESPACE}'`, `xmlns='${SPREADSHEET_NAMESPACE}'`)
        .replace(/<(\/?)x:/g, "<$1");
    }
    if (path.endsWith(".rels")) {
      normalized = normalizeRelationshipTargets(normalized, path);
    }

    if (normalized !== original) {
      archive.file(path, normalized);
      changed = true;
    }
  }

  return changed
    ? archive.generateAsync({ type: "nodebuffer", compression: "DEFLATE" })
    : null;
}

async function loadWorkbook(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as never);
    return workbook;
  } catch (originalError) {
    const normalizedBuffer = await normalizeArtifactToolWorkbook(buffer);
    if (normalizedBuffer === null) {
      throw originalError;
    }
    const normalizedWorkbook = new ExcelJS.Workbook();
    await normalizedWorkbook.xlsx.load(normalizedBuffer as never);
    return normalizedWorkbook;
  }
}

function cellText(cell: ExcelJS.Cell): string {
  if (cell.hyperlink) {
    return cell.hyperlink.trim();
  }

  return cell.text.trim();
}

function normalizeIdentity(brand: string, standardModel: string): string {
  return `${brand.trim().toLocaleLowerCase()}\u0000${standardModel.trim().toLocaleLowerCase()}`;
}

function zodErrorToImportError<T>(
  sheet: string,
  row: number,
  issue: ZodIssue,
  fieldLabels: FieldLabels<T>
): ImportRowError {
  const fieldKey = String(issue.path[0] ?? "行数据") as keyof T;
  return {
    sheet,
    row,
    field: fieldLabels[fieldKey] ?? String(fieldKey),
    message: issue.message
  };
}

function validateHeaders(
  sheet: ExcelJS.Worksheet,
  expectedHeaders: readonly string[]
): ImportRowError[] {
  const actual = new Set<string>();
  sheet.getRow(HEADER_ROW).eachCell({ includeEmpty: false }, (cell) => {
    actual.add(cellText(cell));
  });

  return expectedHeaders
    .filter((header) => !actual.has(header))
    .map((header) => ({
      sheet: sheet.name,
      row: HEADER_ROW,
      field: header,
      message: `缺少必需表头“${header}”`
    }));
}

function parseRows<TInput extends Record<string, string>, TOutput>(
  sheet: ExcelJS.Worksheet,
  fieldLabels: FieldLabels<TInput>,
  schema: ZodType<TOutput>
): { rows: Array<ParsedRow<TOutput>>; errors: ImportRowError[] } {
  const headerColumns = new Map<string, number>();
  sheet.getRow(HEADER_ROW).eachCell({ includeEmpty: false }, (cell, columnNumber) => {
    headerColumns.set(cellText(cell), columnNumber);
  });

  const rows: Array<ParsedRow<TOutput>> = [];
  const errors: ImportRowError[] = [];
  const lastRow = Math.max(sheet.lastRow?.number ?? 0, FIRST_DATA_ROW - 1);

  for (let rowNumber = FIRST_DATA_ROW; rowNumber <= lastRow; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const raw = Object.fromEntries(
      Object.entries(fieldLabels).map(([field, label]) => [
        field,
        cellText(row.getCell(headerColumns.get(label) ?? 0))
      ])
    ) as TInput;

    if (Object.values(raw).every((value) => value === "")) {
      continue;
    }

    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      errors.push(...parsed.error.issues.map((issue) =>
        zodErrorToImportError(sheet.name, rowNumber, issue, fieldLabels)
      ));
      continue;
    }

    rows.push({ value: parsed.data, sourceRow: rowNumber });
  }

  return { rows, errors };
}

function groupBundles(rows: Array<ParsedRow<ValidatedBundleRow>>): ValidatedBundleImport[] {
  const groups = new Map<string, ValidatedBundleImport>();

  for (const row of rows) {
    const current = groups.get(row.value.bundleCode) ?? {
      code: row.value.bundleCode,
      mainBrand: row.value.mainBrand,
      mainModel: row.value.mainModel,
      items: []
    };
    current.items.push({ ...row.value, sourceRow: row.sourceRow });
    groups.set(row.value.bundleCode, current);
  }

  return [...groups.values()];
}

export class CatalogImportService {
  private readonly writer: CatalogImportWriter;

  constructor(writer: CatalogImportWriter) {
    this.writer = writer;
  }

  async importWorkbook(buffer: Buffer, actorId: string): Promise<CatalogImportResult> {
    if (actorId.trim() === "") {
      throw new Error("actorId is required");
    }

    let workbook: ExcelJS.Workbook;
    try {
      workbook = await loadWorkbook(buffer);
    } catch {
      return {
        imported: 0,
        updated: 0,
        errors: [{ sheet: "文件", row: 0, field: "文件", message: "无法读取 Excel 文件，请确认文件为有效的 .xlsx 格式" }]
      };
    }

    const errors: ImportRowError[] = [];
    const requiredSheets = ["监控型号", "套装明细", "型号别名", "填写说明"] as const;
    for (const sheetName of requiredSheets) {
      if (!workbook.getWorksheet(sheetName)) {
        errors.push({ sheet: sheetName, row: 0, field: "工作表", message: `缺少工作表“${sheetName}”` });
      }
    }

    if (errors.length > 0) {
      return { imported: 0, updated: 0, errors };
    }

    const modelSheet = workbook.getWorksheet("监控型号")!;
    const bundleSheet = workbook.getWorksheet("套装明细")!;
    const aliasSheet = workbook.getWorksheet("型号别名")!;

    errors.push(...validateHeaders(modelSheet, MODEL_HEADERS));
    errors.push(...validateHeaders(bundleSheet, BUNDLE_HEADERS));
    errors.push(...validateHeaders(aliasSheet, ALIAS_HEADERS));
    if (errors.length > 0) {
      return { imported: 0, updated: 0, errors };
    }

    const parsedModels = parseRows(modelSheet, MODEL_FIELD_LABELS, modelRowSchema);
    const parsedBundles = parseRows(bundleSheet, BUNDLE_FIELD_LABELS, bundleRowSchema);
    const parsedAliases = parseRows(aliasSheet, ALIAS_FIELD_LABELS, aliasRowSchema);
    errors.push(...parsedModels.errors, ...parsedBundles.errors, ...parsedAliases.errors);

    if (parsedModels.rows.length === 0) {
      errors.push({ sheet: "监控型号", row: FIRST_DATA_ROW, field: "监控编号", message: "至少需要填写一个监控型号" });
    }

    const monitorCodeRows = new Map<string, number[]>();
    for (const model of parsedModels.rows) {
      const rows = monitorCodeRows.get(model.value.monitorCode) ?? [];
      rows.push(model.sourceRow);
      monitorCodeRows.set(model.value.monitorCode, rows);
    }
    for (const [monitorCode, rows] of monitorCodeRows) {
      if (rows.length > 1) {
        errors.push(...rows.map((row) => ({
          sheet: "监控型号",
          row,
          field: "监控编号",
          message: `监控编号“${monitorCode}”重复`
        })));
      }
    }

    const bundleCodes = new Set(parsedBundles.rows.map((row) => row.value.bundleCode));
    for (const model of parsedModels.rows) {
      if (
        model.value.comparisonType === "BUNDLE" &&
        model.value.bundleCode !== null &&
        !bundleCodes.has(model.value.bundleCode)
      ) {
        errors.push({
          sheet: "监控型号",
          row: model.sourceRow,
          field: "套装编号",
          message: `套装编号“${model.value.bundleCode}”在套装明细中没有对应内容`
        });
      }
    }

    const modelIdentities = new Set(parsedModels.rows.map((row) =>
      normalizeIdentity(row.value.brand, row.value.standardModel)
    ));
    for (const alias of parsedAliases.rows) {
      if (!modelIdentities.has(normalizeIdentity(alias.value.brand, alias.value.standardModel))) {
        errors.push({
          sheet: "型号别名",
          row: alias.sourceRow,
          field: "标准型号",
          message: `品牌“${alias.value.brand}”的型号“${alias.value.standardModel}”未出现在监控型号表`
        });
      }
    }

    if (errors.length > 0) {
      return { imported: 0, updated: 0, errors };
    }

    const catalog: ValidatedCatalogImport = {
      models: parsedModels.rows.map(({ value, sourceRow }) => ({
        ...value,
        sourceRow,
        ownListing: {
          platform: "TMALL",
          shopName: "星空乐器专营店",
          url: value.ownUrl,
          skuText: value.ownSkuText
        }
      })),
      bundles: groupBundles(parsedBundles.rows),
      aliases: parsedAliases.rows.map(({ value, sourceRow }) => ({ ...value, sourceRow }))
    };

    const counts = await this.writer.importAtomically(catalog, actorId);
    return { ...counts, errors: [] };
  }
}
