import assert from "node:assert/strict";
import test from "node:test";

import { AuditService, type AuditEntryInput } from "../audit/audit.service.ts";
import {
  CatalogService,
  type CatalogModelRecord,
  type CatalogRepository
} from "./catalog.service.ts";

class InMemoryCatalogRepository implements CatalogRepository {
  models = new Map<string, CatalogModelRecord>();
  bundleCodes = new Map<string, string>([["PKG-RME-001", "bundle-1"]]);
  nextId = 1;

  async listModels(): Promise<CatalogModelRecord[]> {
    return [...this.models.values()];
  }

  async findModelById(id: string): Promise<CatalogModelRecord | null> {
    return this.models.get(id) ?? null;
  }

  async findModelByMonitorCode(monitorCode: string): Promise<CatalogModelRecord | null> {
    return [...this.models.values()].find((model) => model.monitorCode === monitorCode) ?? null;
  }

  async findBundleIdByCode(code: string): Promise<string | null> {
    return this.bundleCodes.get(code) ?? null;
  }

  async createModel(input: Omit<CatalogModelRecord, "id">): Promise<CatalogModelRecord> {
    const stored = { id: `model-${this.nextId++}`, ...input };
    this.models.set(stored.id, stored);
    return stored;
  }

  async updateModel(id: string, input: Omit<CatalogModelRecord, "id">): Promise<CatalogModelRecord> {
    const stored = { id, ...input };
    this.models.set(id, stored);
    return stored;
  }

  async setModelEnabled(id: string, enabled: boolean): Promise<CatalogModelRecord> {
    const current = this.models.get(id)!;
    const stored = { ...current, enabled };
    this.models.set(id, stored);
    return stored;
  }

  async listBundlesForModel(id: string) {
    const model = this.models.get(id);
    return model?.bundleCode ? [{ code: model.bundleCode }] : [];
  }

  async listAliasesForModel() {
    return [{ phrase: "娃娃脸FS", type: "EFFECTIVE" as const }];
  }
}

function validBareInput() {
  return {
    monitorCode: "MON-0001",
    enabled: true,
    brand: "RME",
    standardModel: "Babyface Pro FS",
    category: "声卡",
    searchQuery: "RME Babyface Pro FS",
    version: "FS新版",
    mustIncludeTerms: ["Babyface", "FS"],
    excludedTerms: ["二手"],
    ownUrl: "https://detail.tmall.com/item.htm?id=1001",
    ownSkuText: "Babyface Pro FS单机",
    comparisonType: "BARE" as const,
    bundleCode: null,
    colorComparable: false,
    owner: "张三",
    notes: null
  };
}

function createService() {
  const repository = new InMemoryCatalogRepository();
  const audits: AuditEntryInput[] = [];
  const audit = new AuditService({ create: async (entry) => { audits.push(entry); } });
  return { repository, audits, service: new CatalogService(repository, audit) };
}

test("creates and edits a monitored model with before/after audit records", async () => {
  const { service, audits } = createService();

  const created = await service.createModel(validBareInput(), "operator-1");
  const updated = await service.updateModel(created.id, { owner: "李四" }, "operator-2");

  assert.equal(updated.owner, "李四");
  assert.deepEqual(audits.map((entry) => entry.action), [
    "catalog.model.created",
    "catalog.model.updated"
  ]);
  assert.equal(audits[1]?.actorId, "operator-2");
  assert.deepEqual(audits[1]?.before && (audits[1].before as { owner: string }).owner, "张三");
  assert.deepEqual(audits[1]?.after && (audits[1].after as { owner: string }).owner, "李四");
});

test("toggles a model and audits the state change", async () => {
  const { service, audits } = createService();
  const created = await service.createModel(validBareInput(), "operator-1");

  const toggled = await service.toggleModel(created.id, "operator-2");

  assert.equal(toggled.enabled, false);
  assert.equal(audits.at(-1)?.action, "catalog.model.disabled");
});

test("rejects a bare model with a bundle code", async () => {
  const { service } = createService();

  await assert.rejects(
    service.createModel({ ...validBareInput(), bundleCode: "PKG-RME-001" }, "operator-1"),
    /裸机.*套装编号.*留空/
  );
});

test("rejects a bundle model without an existing bundle", async () => {
  const { service } = createService();

  await assert.rejects(
    service.createModel({ ...validBareInput(), comparisonType: "BUNDLE", bundleCode: null }, "operator-1"),
    /套装编号/
  );
  await assert.rejects(
    service.createModel({ ...validBareInput(), comparisonType: "BUNDLE", bundleCode: "PKG-NOT-FOUND" }, "operator-1"),
    /不存在/
  );
});

test("lists models, bundles and aliases for the management API", async () => {
  const { service } = createService();
  const created = await service.createModel({
    ...validBareInput(),
    comparisonType: "BUNDLE",
    bundleCode: "PKG-RME-001"
  }, "operator-1");

  assert.equal((await service.listModels()).length, 1);
  assert.deepEqual(await service.listBundles(created.id), [{ code: "PKG-RME-001" }]);
  assert.deepEqual(await service.listAliases(created.id), [{ phrase: "娃娃脸FS", type: "EFFECTIVE" }]);
});
