import assert from "node:assert/strict";
import test from "node:test";

import { CatalogTemplateService } from "./catalog-template.service.ts";

test("returns the distributed xlsx template", async () => {
  const template = await new CatalogTemplateService().getTemplate();

  assert.equal(template.filename, "天猫比价监控_运营录入模板.xlsx");
  assert.equal(template.contentType, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  assert.equal(template.buffer.subarray(0, 2).toString("ascii"), "PK");
});
