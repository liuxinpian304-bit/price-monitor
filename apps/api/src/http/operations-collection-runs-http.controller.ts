import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Query,
  Res,
  ServiceUnavailableException
} from "@nestjs/common";
import type { Response } from "express";

import { Roles } from "../auth/roles.guard.ts";
import type {
  CollectionRunReportConfidence,
  CollectionRunReportFilters,
  CollectionRunReportMatch,
  CollectionRunReportPrice,
  CollectionRunReportSource,
  CollectionRunReportDetail,
  CollectionRunReportSummary
} from "../operations/collection-report-query.service.ts";

export interface CollectionRunsOperationsService {
  listRuns(): Promise<{ runs: CollectionRunReportSummary[] }>;
  getRun(runId: string, filters?: CollectionRunReportFilters): Promise<CollectionRunReportDetail | null>;
  isEvidenceReferenced(runId: string, sha256: string): Promise<boolean>;
}

export interface CollectionEvidenceReader {
  read(runId: string, sha256: string): Promise<Buffer | null>;
}

export const COLLECTION_REPORT_QUERY_SERVICE = Symbol("collection-report-query-service");
export const COLLECTION_EVIDENCE_STORE = Symbol("collection-evidence-store");

const runIdPattern = /^[A-Za-z0-9_-]+$/;
const sha256Pattern = /^[0-9a-f]{64}$/;

function optionalEnum<T extends string>(value: unknown, accepted: readonly T[], field: string): T | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string" || !accepted.includes(value as T)) {
    throw new BadRequestException(`${field} 无效`);
  }
  return value as T;
}

function filtersFromQuery(query: Record<string, unknown>): CollectionRunReportFilters {
  const source = optionalEnum<CollectionRunReportSource>(query.source, ["OWN", "COMPETITOR"], "source");
  const match = optionalEnum<CollectionRunReportMatch>(query.match, ["EXACT", "REVIEW", "EXCLUDED"], "match");
  const price = optionalEnum<CollectionRunReportPrice>(query.price, ["LOWER", "NOT_LOWER"], "price");
  const confidence = optionalEnum<CollectionRunReportConfidence>(
    query.confidence,
    ["CONFIRMED", "ESTIMATED", "MANUAL_REVIEW"],
    "confidence"
  );
  const filters: CollectionRunReportFilters = {};
  if (source) filters.source = source;
  if (match) filters.match = match;
  if (price) filters.price = price;
  if (confidence) filters.confidence = confidence;
  return filters;
}

function validRunId(runId: string): boolean {
  return runIdPattern.test(runId) && runId !== "." && runId !== "..";
}

export class OperationsCollectionRunsHttpController {
  private readonly reports: CollectionRunsOperationsService;
  private readonly evidenceStore: CollectionEvidenceReader;

  constructor(reports: CollectionRunsOperationsService, evidenceStore: CollectionEvidenceReader) {
    this.reports = reports;
    this.evidenceStore = evidenceStore;
  }

  list() {
    return this.reports.listRuns();
  }

  async detail(runId: string, query: Record<string, unknown>) {
    if (!validRunId(runId)) throw new BadRequestException("runId 无效");
    const result = await this.reports.getRun(runId, filtersFromQuery(query));
    if (!result) throw new NotFoundException("采集运行不存在");
    return result;
  }

  async evidence(
    runId: string,
    sha256: string,
    response: Response
  ): Promise<void> {
    if (!validRunId(runId) || !sha256Pattern.test(sha256)) {
      throw new BadRequestException("证据标识无效");
    }
    if (!await this.reports.isEvidenceReferenced(runId, sha256)) {
      throw new NotFoundException("证据不存在");
    }
    let bytes: Buffer | null;
    try {
      bytes = await this.evidenceStore.read(runId, sha256);
    } catch {
      throw new ServiceUnavailableException("证据暂时不可读取");
    }
    if (!bytes) throw new NotFoundException("证据不存在");
    response.setHeader("Cache-Control", "private, no-store");
    response.type("image/png").send(bytes);
  }
}

const controllerPrototype = OperationsCollectionRunsHttpController.prototype;
Inject(COLLECTION_REPORT_QUERY_SERVICE)(OperationsCollectionRunsHttpController, undefined, 0);
Inject(COLLECTION_EVIDENCE_STORE)(OperationsCollectionRunsHttpController, undefined, 1);
Controller("operations/collection-runs")(OperationsCollectionRunsHttpController);
Roles("ADMIN")(OperationsCollectionRunsHttpController);

Get()(controllerPrototype, "list", Object.getOwnPropertyDescriptor(controllerPrototype, "list")!);

Param("runId")(controllerPrototype, "detail", 0);
Query()(controllerPrototype, "detail", 1);
Get(":runId")(controllerPrototype, "detail", Object.getOwnPropertyDescriptor(controllerPrototype, "detail")!);

Param("runId")(controllerPrototype, "evidence", 0);
Param("sha256")(controllerPrototype, "evidence", 1);
Res()(controllerPrototype, "evidence", 2);
Get(":runId/evidence/:sha256")(
  controllerPrototype,
  "evidence",
  Object.getOwnPropertyDescriptor(controllerPrototype, "evidence")!
);
