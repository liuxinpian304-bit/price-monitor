import { z } from "zod";

import { AuditService, type JsonValue } from "../audit/audit.service.ts";
import {
  catalogModelSchema,
  updateCatalogModelSchema,
  type CreateCatalogModelInput,
  type UpdateCatalogModelInput,
  type ValidatedCatalogModelInput
} from "./catalog.dto.ts";

export interface CatalogModelRecord extends ValidatedCatalogModelInput {
  id: string;
}

export interface CatalogBundleSummary {
  code: string;
  title?: string | null;
  items?: Array<{
    accessoryType: string;
    brand: string | null;
    modelOrName: string;
    quantity: number;
    unitValueFen: number;
    core: boolean;
  }>;
}

export interface CatalogAliasSummary {
  phrase: string;
  type: "EFFECTIVE" | "EXCLUDED";
  notes?: string | null;
}

export interface CatalogRepository {
  listModels(): Promise<CatalogModelRecord[]>;
  findModelById(id: string): Promise<CatalogModelRecord | null>;
  findModelByMonitorCode(monitorCode: string): Promise<CatalogModelRecord | null>;
  findBundleIdByCode(code: string): Promise<string | null>;
  createModel(input: ValidatedCatalogModelInput, bundleId: string | null): Promise<CatalogModelRecord>;
  updateModel(id: string, input: ValidatedCatalogModelInput, bundleId: string | null): Promise<CatalogModelRecord>;
  setModelEnabled(id: string, enabled: boolean): Promise<CatalogModelRecord>;
  listBundlesForModel(id: string): Promise<CatalogBundleSummary[]>;
  listAliasesForModel(id: string): Promise<CatalogAliasSummary[]>;
}

export class CatalogValidationError extends Error {}
export class CatalogConflictError extends Error {}
export class CatalogNotFoundError extends Error {}

function errorMessage(error: z.ZodError): string {
  return error.issues.map((issue) => issue.message).join("；");
}

function asJson(record: CatalogModelRecord | null): JsonValue {
  if (record === null) {
    return null;
  }

  return JSON.parse(JSON.stringify(record)) as JsonValue;
}

export class CatalogService {
  private readonly repository: CatalogRepository;
  private readonly audit: AuditService;

  constructor(repository: CatalogRepository, audit: AuditService) {
    this.repository = repository;
    this.audit = audit;
  }

  async listModels(): Promise<CatalogModelRecord[]> {
    return this.repository.listModels();
  }

  async createModel(input: CreateCatalogModelInput, actorId: string): Promise<CatalogModelRecord> {
    const parsed = catalogModelSchema.safeParse(input);
    if (!parsed.success) {
      throw new CatalogValidationError(errorMessage(parsed.error));
    }

    const duplicate = await this.repository.findModelByMonitorCode(parsed.data.monitorCode);
    if (duplicate) {
      throw new CatalogConflictError(`监控编号“${parsed.data.monitorCode}”已存在`);
    }

    const bundleId = await this.resolveBundleId(parsed.data);
    const created = await this.repository.createModel(parsed.data, bundleId);
    await this.audit.record({
      actorId,
      action: "catalog.model.created",
      entityType: "MonitoredModel",
      entityId: created.id,
      before: null,
      after: asJson(created)
    });
    return created;
  }

  async updateModel(
    id: string,
    patch: UpdateCatalogModelInput,
    actorId: string
  ): Promise<CatalogModelRecord> {
    const existing = await this.requireModel(id);
    const parsedPatch = updateCatalogModelSchema.safeParse(patch);
    if (!parsedPatch.success) {
      throw new CatalogValidationError(errorMessage(parsedPatch.error));
    }

    const parsed = catalogModelSchema.safeParse({ ...existing, ...parsedPatch.data });
    if (!parsed.success) {
      throw new CatalogValidationError(errorMessage(parsed.error));
    }

    if (parsed.data.monitorCode !== existing.monitorCode) {
      const duplicate = await this.repository.findModelByMonitorCode(parsed.data.monitorCode);
      if (duplicate && duplicate.id !== id) {
        throw new CatalogConflictError(`监控编号“${parsed.data.monitorCode}”已存在`);
      }
    }

    const bundleId = await this.resolveBundleId(parsed.data);
    const updated = await this.repository.updateModel(id, parsed.data, bundleId);
    await this.audit.record({
      actorId,
      action: "catalog.model.updated",
      entityType: "MonitoredModel",
      entityId: id,
      before: asJson(existing),
      after: asJson(updated)
    });
    return updated;
  }

  async toggleModel(id: string, actorId: string): Promise<CatalogModelRecord> {
    const existing = await this.requireModel(id);
    const updated = await this.repository.setModelEnabled(id, !existing.enabled);
    await this.audit.record({
      actorId,
      action: updated.enabled ? "catalog.model.enabled" : "catalog.model.disabled",
      entityType: "MonitoredModel",
      entityId: id,
      before: asJson(existing),
      after: asJson(updated)
    });
    return updated;
  }

  async listBundles(id: string): Promise<CatalogBundleSummary[]> {
    await this.requireModel(id);
    return this.repository.listBundlesForModel(id);
  }

  async listAliases(id: string): Promise<CatalogAliasSummary[]> {
    await this.requireModel(id);
    return this.repository.listAliasesForModel(id);
  }

  private async requireModel(id: string): Promise<CatalogModelRecord> {
    const model = await this.repository.findModelById(id);
    if (!model) {
      throw new CatalogNotFoundError(`监控型号“${id}”不存在`);
    }
    return model;
  }

  private async resolveBundleId(model: ValidatedCatalogModelInput): Promise<string | null> {
    if (model.bundleCode === null) {
      return null;
    }

    const bundleId = await this.repository.findBundleIdByCode(model.bundleCode);
    if (!bundleId) {
      throw new CatalogValidationError(`套装编号“${model.bundleCode}”不存在`);
    }
    return bundleId;
  }
}
