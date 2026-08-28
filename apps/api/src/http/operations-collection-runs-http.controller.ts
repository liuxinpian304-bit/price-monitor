import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
  ServiceUnavailableException
} from "@nestjs/common";
import type { Request, Response } from "express";

import {
  RunAlertNotificationApprovalValidationError,
  RunAlertNotificationBatchNotFoundError,
  type RunAlertNotificationApprovalInput,
  type RunAlertNotificationPreview
} from "../alerts/run-alert-notification-approval.service.ts";
import { Roles } from "../auth/roles.guard.ts";
import { RoleForbiddenError, type UserRole } from "../settings/settings.service.ts";
import { requestIdentity } from "./identity.ts";
import type {
  CollectionReportPaginationInput,
  CollectionRunDetailPaginationInput,
  CollectionRunReportConfidence,
  CollectionRunReportCombinationState,
  CollectionRunReportList,
  CollectionRunReportFilters,
  CollectionRunReportMatch,
  CollectionRunReportPrice,
  CollectionRunReportSource,
  CollectionRunReportDetail
} from "../operations/collection-report-query.service.ts";
import {
  COLLECTION_REPORT_MAX_PAGE,
  COLLECTION_REPORT_MAX_PAGE_SIZE
} from "../operations/collection-report-query.service.ts";

export interface CollectionRunsOperationsService {
  listRuns(input?: CollectionReportPaginationInput): Promise<CollectionRunReportList>;
  getRun(
    runId: string,
    filters?: CollectionRunReportFilters,
    pagination?: CollectionRunDetailPaginationInput
  ): Promise<CollectionRunReportDetail | null>;
  isEvidenceReferenced(runId: string, sha256: string): Promise<boolean>;
}

export interface CollectionEvidenceReader {
  read(runId: string, sha256: string): Promise<Buffer | null>;
}

export interface RunAlertNotificationApprovalApi {
  preview(runId: string): Promise<RunAlertNotificationPreview>;
  approve(
    input: RunAlertNotificationApprovalInput,
    actorId: string,
    role: UserRole
  ): Promise<void>;
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
  const combinationState = optionalEnum<CollectionRunReportCombinationState>(
    query.combinationState,
    ["OWN", "MATCHED", "MISSING_OWN", "REVIEW", "EXCLUDED"],
    "combinationState"
  );
  const filters: CollectionRunReportFilters = {};
  if (source) filters.source = source;
  if (match) filters.match = match;
  if (price) filters.price = price;
  if (confidence) filters.confidence = confidence;
  if (combinationState) filters.combinationState = combinationState;
  return filters;
}

function optionalPositiveInteger(value: unknown, field: string, maximum: number): number | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new BadRequestException(`${field} 无效`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new BadRequestException(`${field} 无效`);
  }
  return parsed;
}

function listPaginationFromQuery(query: Record<string, unknown>): CollectionReportPaginationInput {
  const page = optionalPositiveInteger(query.page, "page", COLLECTION_REPORT_MAX_PAGE);
  const pageSize = optionalPositiveInteger(query.pageSize, "pageSize", COLLECTION_REPORT_MAX_PAGE_SIZE);
  const pagination: CollectionReportPaginationInput = {};
  if (page !== undefined) pagination.page = page;
  if (pageSize !== undefined) pagination.pageSize = pageSize;
  return pagination;
}

function detailPaginationFromQuery(query: Record<string, unknown>): CollectionRunDetailPaginationInput {
  const pagination: CollectionRunDetailPaginationInput = {};
  const fields = [
    ["positionPage", COLLECTION_REPORT_MAX_PAGE],
    ["positionPageSize", COLLECTION_REPORT_MAX_PAGE_SIZE],
    ["issuePage", COLLECTION_REPORT_MAX_PAGE],
    ["issuePageSize", COLLECTION_REPORT_MAX_PAGE_SIZE],
    ["skuPage", COLLECTION_REPORT_MAX_PAGE],
    ["skuPageSize", COLLECTION_REPORT_MAX_PAGE_SIZE]
  ] as const;
  for (const [field, maximum] of fields) {
    const value = optionalPositiveInteger(query[field], field, maximum);
    if (value !== undefined) pagination[field] = value;
  }
  return pagination;
}

function validRunId(runId: string): boolean {
  return runIdPattern.test(runId) && runId !== "." && runId !== "..";
}

async function asNotificationRequest<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof RunAlertNotificationBatchNotFoundError) {
      throw new NotFoundException(error.message);
    }
    if (error instanceof RunAlertNotificationApprovalValidationError) {
      throw new BadRequestException(error.message);
    }
    if (error instanceof RoleForbiddenError) {
      throw new ForbiddenException(error.message);
    }
    throw error;
  }
}

export class OperationsCollectionRunsHttpController {
  private readonly reports: CollectionRunsOperationsService;
  private readonly evidenceStore: CollectionEvidenceReader;
  private readonly notificationApproval: RunAlertNotificationApprovalApi | undefined;

  constructor(
    reports: CollectionRunsOperationsService,
    evidenceStore: CollectionEvidenceReader,
    notificationApproval?: RunAlertNotificationApprovalApi
  ) {
    this.reports = reports;
    this.evidenceStore = evidenceStore;
    this.notificationApproval = notificationApproval;
  }

  list(query: Record<string, unknown>) {
    return this.reports.listRuns(listPaginationFromQuery(query));
  }

  async detail(runId: string, query: Record<string, unknown>) {
    if (!validRunId(runId)) throw new BadRequestException("runId 无效");
    const result = await this.reports.getRun(
      runId,
      filtersFromQuery(query),
      detailPaginationFromQuery(query)
    );
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

  async notificationPreview(runId: string): Promise<RunAlertNotificationPreview> {
    if (!validRunId(runId)) throw new BadRequestException("runId 无效");
    const approval = await this.notificationApprovalService();
    return asNotificationRequest(() => approval.preview(runId));
  }

  async notificationConfirm(
    runId: string,
    body: { previewDigest?: unknown; confirmation?: unknown },
    request: Request
  ): Promise<{ confirmed: true }> {
    if (!validRunId(runId)) throw new BadRequestException("runId 无效");
    if (
      typeof body?.previewDigest !== "string"
      || typeof body.confirmation !== "string"
    ) throw new BadRequestException("企业微信确认参数无效");
    const identity = requestIdentity(request);
    const approval = await this.notificationApprovalService();
    await asNotificationRequest(() => approval.approve({
      runId,
      previewDigest: body.previewDigest as string,
      confirmation: body.confirmation as string
    }, identity.actorId, identity.role));
    return { confirmed: true };
  }

  private async notificationApprovalService(): Promise<RunAlertNotificationApprovalApi> {
    if (this.notificationApproval) return this.notificationApproval;
    return (await import("../runtime.ts")).runAlertNotificationApprovalService;
  }
}

const controllerPrototype = OperationsCollectionRunsHttpController.prototype;
Inject(COLLECTION_REPORT_QUERY_SERVICE)(OperationsCollectionRunsHttpController, undefined, 0);
Inject(COLLECTION_EVIDENCE_STORE)(OperationsCollectionRunsHttpController, undefined, 1);
Controller("operations/collection-runs")(OperationsCollectionRunsHttpController);
Roles("ADMIN")(OperationsCollectionRunsHttpController);

Query()(controllerPrototype, "list", 0);
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

Param("runId")(controllerPrototype, "notificationPreview", 0);
Get(":runId/notification-preview")(
  controllerPrototype,
  "notificationPreview",
  Object.getOwnPropertyDescriptor(controllerPrototype, "notificationPreview")!
);

Param("runId")(controllerPrototype, "notificationConfirm", 0);
Body()(controllerPrototype, "notificationConfirm", 1);
Req()(controllerPrototype, "notificationConfirm", 2);
Post(":runId/notification-confirm")(
  controllerPrototype,
  "notificationConfirm",
  Object.getOwnPropertyDescriptor(controllerPrototype, "notificationConfirm")!
);
