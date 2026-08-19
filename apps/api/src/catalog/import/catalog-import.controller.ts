import { CatalogImportService, type CatalogImportResult } from "./catalog-import.service.ts";

export interface CatalogUpload {
  originalName: string;
  buffer: Buffer;
}

export class CatalogImportController {
  private readonly service: CatalogImportService;

  constructor(service: CatalogImportService) {
    this.service = service;
  }

  async importCatalog(file: CatalogUpload | undefined, actorId: string): Promise<CatalogImportResult> {
    if (!file) {
      return {
        imported: 0,
        updated: 0,
        errors: [{ sheet: "文件", row: 0, field: "文件", message: "请选择要导入的 Excel 文件" }]
      };
    }

    if (!file.originalName.toLocaleLowerCase().endsWith(".xlsx")) {
      return {
        imported: 0,
        updated: 0,
        errors: [{ sheet: "文件", row: 0, field: "文件", message: "仅支持 .xlsx 文件" }]
      };
    }

    return this.service.importWorkbook(file.buffer, actorId);
  }
}
