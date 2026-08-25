import {
  collectorReportSchema,
  type CollectorReport
} from "../../../../packages/contracts/src/index.ts";
import { createHash } from "node:crypto";
import { z } from "zod";

import type { CollectorAgentService } from "../collector-agent/collector-agent.service.ts";
import type { CollectionEvidenceStore } from "./collection-evidence-store.ts";

export type TerminalCollectionStatus = "SUCCEEDED" | "PARTIAL_FAILED" | "FAILED";
export type ClaimedCollectionStatus =
  | "QUEUED"
  | "RUNNING"
  | "PAUSED_LOGIN"
  | "PAUSED_CHALLENGE"
  | "COALESCED"
  | TerminalCollectionStatus;

export interface IngestionSummary {
  runId: string;
  status: TerminalCollectionStatus;
  positionCount: number;
  uniqueItemCount: number;
  skuCount: number;
  issueCount: number;
  ownSnapshotIds: string[];
  competitorSnapshotIds: string[];
}

export const ingestionSummarySchema = z.object({
  runId: z.string().min(1).max(160),
  status: z.enum(["SUCCEEDED", "PARTIAL_FAILED", "FAILED"]),
  positionCount: z.number().int().nonnegative().max(2_147_483_647),
  uniqueItemCount: z.number().int().nonnegative().max(2_147_483_647),
  skuCount: z.number().int().nonnegative().max(2_147_483_647),
  issueCount: z.number().int().nonnegative().max(2_147_483_647),
  ownSnapshotIds: z.array(z.string().min(1).max(160)),
  competitorSnapshotIds: z.array(z.string().min(1).max(160))
}).strict();

export interface ClaimedDesktopRun {
  runId: string;
  agentId: string;
  monitoredModelId: string;
  providerKey: string;
  searchLimit: number;
  status: ClaimedCollectionStatus;
  ownListingIds: string[];
}

export interface DesktopReportRepository {
  inspectRun(agentId: string, runId: string): Promise<ClaimedDesktopRun | null>;
  withEvidenceRunLock<T>(
    agentId: string,
    runId: string,
    operation: (mode: "CREATE_OR_REPLAY" | "REPLAY_ONLY") => Promise<T>
  ): Promise<T>;
  ingest(
    agentId: string,
    report: CollectorReport,
    verifyEvidence: () => Promise<void>
  ): Promise<{ summary: IngestionSummary; newlyAccepted: boolean }>;
  recordSystemError(agentId: string, runId: string, code: string, message: string): Promise<void>;
}

export const INGESTION_DISPOSITION = Symbol("desktop-report-ingestion-disposition");

type IngestionSummaryWithDisposition = IngestionSummary & {
  [INGESTION_DISPOSITION]?: "created" | "existing";
};

export function wasIngestionNew(summary: IngestionSummary): boolean {
  return (summary as IngestionSummaryWithDisposition)[INGESTION_DISPOSITION] === "created";
}

export class DesktopReportValidationError extends Error {
  constructor() {
    super("Invalid desktop collector report");
    this.name = "DesktopReportValidationError";
  }
}

export class DesktopReportConflictError extends Error {
  constructor() {
    super("Desktop collector report conflicts with the claimed run");
    this.name = "DesktopReportConflictError";
  }
}

export class DesktopReportIngestionError extends Error {
  constructor() {
    super("Desktop report ingestion failed");
    this.name = "DesktopReportIngestionError";
  }
}

const partialFailureIssueCodes = new Set([
  "ITEM_UNAVAILABLE",
  "SKU_ENUMERATION_INCOMPLETE",
  "SKU_SELECTION_MISMATCH",
  "PRICE_UNSTABLE",
  "UI_CONTRACT_CHANGED",
  "MISSING_ITEM_ID"
]);

const fatalFailureIssueCodes = new Set([
  "MISSING_ITEM_ID",
  "APP_VERSION_UNSUPPORTED",
  "UI_CONTRACT_CHANGED",
  "SCREEN_RECORDING_PERMISSION_REQUIRED"
]);

const reportEndpointForbiddenIssueCodes = new Set([
  "LOGIN_REQUIRED",
  "PLATFORM_CHALLENGE",
  "OWN_BASELINE_MISSING",
  "OWN_BASELINE_AMBIGUOUS"
]);

function validateTerminalSemantics(report: CollectorReport): void {
  if (report.status === "PAUSED_LOGIN" || report.status === "PAUSED_CHALLENGE") {
    throw new DesktopReportValidationError();
  }
  if (report.issues.some((issue) => reportEndpointForbiddenIssueCodes.has(issue.code))) {
    throw new DesktopReportValidationError();
  }

  if (report.status === "SUCCEEDED") {
    if (report.issues.length !== 0) throw new DesktopReportValidationError();
    return;
  }

  const hasProgress = report.positions.length > 0 || report.ownItems.length > 0;
  if (report.status === "PARTIAL_FAILED") {
    if (!hasProgress || !report.issues.some((issue) => partialFailureIssueCodes.has(issue.code))) {
      throw new DesktopReportValidationError();
    }
    return;
  }

  if (hasProgress || !report.issues.some((issue) => fatalFailureIssueCodes.has(issue.code))) {
    throw new DesktopReportValidationError();
  }
}

function canonicalizeReportTimestamps(report: CollectorReport): CollectorReport {
  const canonical = structuredClone(report);
  canonical.startedAt = new Date(canonical.startedAt).toISOString();
  canonical.completedAt = new Date(canonical.completedAt).toISOString();
  for (const position of canonical.positions) {
    position.capturedAt = new Date(position.capturedAt).toISOString();
  }
  for (const item of [...canonical.ownItems, ...canonical.competitorItems]) {
    for (const sku of item.skus) {
      sku.capturedAt = new Date(sku.capturedAt).toISOString();
    }
  }
  for (const issue of canonical.issues) {
    issue.capturedAt = new Date(issue.capturedAt).toISOString();
  }
  return canonical;
}

function canonicalJson(value: unknown): string {
  const normalize = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(normalize);
    if (entry && typeof entry === "object") {
      return Object.fromEntries(
        Object.entries(entry as Record<string, unknown>)
          .filter(([, nested]) => nested !== undefined)
          .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
          .map(([key, nested]) => [key, normalize(nested)])
      );
    }
    return entry;
  };
  return JSON.stringify(normalize(value));
}

export function desktopReportDigest(report: CollectorReport): string {
  const canonical = canonicalizeReportTimestamps(report);
  return `sha256:${createHash("sha256").update(canonicalJson(canonical)).digest("hex")}`;
}

function validateReportContract(input: CollectorReport): CollectorReport {
  const parsed = collectorReportSchema.safeParse(input);
  if (!parsed.success) throw new DesktopReportValidationError();
  if (parsed.data.competitorItems.some((item) => item.searchRanks.length === 0)) {
    throw new DesktopReportValidationError();
  }
  validateTerminalSemantics(parsed.data);
  for (const entry of [...parsed.data.positions, ...parsed.data.ownItems, ...parsed.data.competitorItems]) {
    let itemId: string | null = null;
    try {
      itemId = new URL(entry.url).searchParams.get("id");
    } catch {
      throw new DesktopReportValidationError();
    }
    if (itemId !== entry.platformItemId) throw new DesktopReportValidationError();
  }
  return canonicalizeReportTimestamps(parsed.data);
}

function validateClaimBinding(
  report: CollectorReport,
  run: ClaimedDesktopRun,
  agentId: string
): void {
  if (run.runId !== report.runId || run.agentId !== agentId || report.collectorId !== agentId) {
    throw new DesktopReportConflictError();
  }
  if (
    run.searchLimit !== report.searchLimit
    || report.positions.length > run.searchLimit
    || (run.status !== "RUNNING"
      && run.status !== "SUCCEEDED"
      && run.status !== "PARTIAL_FAILED"
      && run.status !== "FAILED")
  ) {
    throw new DesktopReportConflictError();
  }
  const claimedOwnListings = new Set(run.ownListingIds);
  const reportedOwnListings = new Set(report.ownItems.map((item) => item.ownListingId));
  if (report.ownItems.some((item) => !claimedOwnListings.has(item.ownListingId))
    || (report.status === "SUCCEEDED"
      && (reportedOwnListings.size !== claimedOwnListings.size
        || [...claimedOwnListings].some((id) => !reportedOwnListings.has(id))))) {
    throw new DesktopReportConflictError();
  }
}

function reportEvidenceKeys(report: CollectorReport): string[] {
  const keys = new Set<string>();
  for (const item of [...report.ownItems, ...report.competitorItems]) {
    for (const sku of item.skus) {
      if (sku.evidenceKey) keys.add(sku.evidenceKey);
    }
  }
  for (const issue of report.issues) {
    if (issue.evidenceKey) keys.add(issue.evidenceKey);
  }
  return [...keys];
}

export class DesktopReportIngestionService {
  private readonly collectorAgentService: CollectorAgentService;
  private readonly repository: DesktopReportRepository;
  private readonly evidenceStore: CollectionEvidenceStore;

  constructor(
    collectorAgentService: CollectorAgentService,
    repository: DesktopReportRepository,
    evidenceStore: CollectionEvidenceStore
  ) {
    this.collectorAgentService = collectorAgentService;
    this.repository = repository;
    this.evidenceStore = evidenceStore;
  }

  async ingest(agentToken: string, input: CollectorReport): Promise<IngestionSummary> {
    const report = validateReportContract(input);
    const ownership = await this.collectorAgentService.assertRunOwnership(agentToken, report.runId);
    const run = await this.repository.inspectRun(ownership.agentId, report.runId);
    if (!run) throw new DesktopReportConflictError();
    validateClaimBinding(report, run, ownership.agentId);

    try {
      const result = await this.repository.ingest(ownership.agentId, report, async () => {
        const evidenceChecks = await Promise.all(
          reportEvidenceKeys(report).map((key) => this.evidenceStore.has(report.runId, key))
        );
        if (evidenceChecks.some((exists) => !exists)) throw new DesktopReportValidationError();
      });
      Object.defineProperty(result.summary, INGESTION_DISPOSITION, {
        value: result.newlyAccepted ? "created" : "existing",
        enumerable: false
      });
      return result.summary;
    } catch (error) {
      if (error instanceof DesktopReportConflictError || error instanceof DesktopReportValidationError) {
        throw error;
      }
      await this.repository.recordSystemError(
        ownership.agentId,
        report.runId,
        "DESKTOP_REPORT_INGESTION_FAILED",
        "Desktop report ingestion failed"
      ).catch(() => undefined);
      throw new DesktopReportIngestionError();
    }
  }

  async uploadEvidence(
    agentToken: string,
    runId: string,
    sha256: string,
    bytes: Uint8Array
  ): Promise<{ evidenceKey: string; created: boolean }> {
    const ownership = await this.collectorAgentService.assertRunOwnership(agentToken, runId);
    return this.repository.withEvidenceRunLock(ownership.agentId, runId, async (mode) => {
      if (mode === "REPLAY_ONLY" && !await this.evidenceStore.has(runId, `sha256:${sha256}`)) {
        throw new DesktopReportConflictError();
      }
      return this.evidenceStore.put(runId, sha256, bytes);
    });
  }
}
