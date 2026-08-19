import { readFile } from "node:fs/promises";

const TEMPLATE_FILENAME = "天猫比价监控_运营录入模板.xlsx";

export class CatalogTemplateService {
  async getTemplate() {
    const buffer = await readFile(new URL(
      `../../../../outputs/tmall-price-monitor/${TEMPLATE_FILENAME}`,
      import.meta.url
    ));
    return {
      filename: TEMPLATE_FILENAME,
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer
    };
  }
}
