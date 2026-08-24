import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { collectorReportSchema, type CollectorReport } from "@stau-price-monitor/contracts";

export interface CollectorCheckpoint {
  schemaVersion: 1;
  checkpointFormatVersion: 2;
  runId: string;
  jobHash: string;
  phase: "OWN_LISTINGS" | "SEARCH" | "ITEMS" | "COMPLETE";
  completedOwnListingIds: string[];
  completedPlatformItemIds: string[];
  completedSkuKeys: string[];
  report: CollectorReport;
  evidenceManifest: Record<string, string>;
  identityAliases: Record<string, string>;
}

const CHECKPOINT_PHASES = ["OWN_LISTINGS", "SEARCH", "ITEMS", "COMPLETE"] as const;
const JOB_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const SKU_ID_PATTERN = /^sku_[0-9a-f]{64}$/;
const EVIDENCE_KEY_PATTERN = /^sha256:[0-9a-f]{64}$/;

function checkpointValidationError(): TypeError {
  return new TypeError("Checkpoint validation failed");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPhase(value: unknown): value is CollectorCheckpoint["phase"] {
  return typeof value === "string" && CHECKPOINT_PHASES.includes(value as CollectorCheckpoint["phase"]);
}

function isUniqueNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.every((entry) => typeof entry === "string" && entry.length > 0)
    && new Set(value).size === value.length;
}

function isCompletedSkuKey(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      && parsed.length === 2
      && typeof parsed[0] === "string"
      && parsed[0].length > 0
      && typeof parsed[1] === "string"
      && SKU_ID_PATTERN.test(parsed[1])
      && JSON.stringify(parsed) === value;
  } catch {
    return false;
  }
}

function isCompletedSkuKeyArray(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.every(isCompletedSkuKey)
    && new Set(value).size === value.length;
}

function isEvidenceManifest(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.entries(value).every(([key, path]) =>
    EVIDENCE_KEY_PATTERN.test(key) && typeof path === "string" && path.length > 0);
}

function isValidIdentityAliases(value: unknown): value is Record<string, string> {
  if (!isRecord(value)) return false;
  const aliases = value;
  for (const [alias, target] of Object.entries(aliases)) {
    if (alias.length === 0 || typeof target !== "string" || target.length === 0 || alias === target) return false;
  }
  for (const alias of Object.keys(aliases)) {
    const visited = new Set<string>();
    let current = alias;
    while (true) {
      const target = aliases[current];
      if (typeof target !== "string") break;
      if (visited.has(current)) return false;
      visited.add(current);
      current = target;
    }
  }
  return true;
}

function reportUsesCurrentSkuIds(report: CollectorReport): boolean {
  return [...report.ownItems, ...report.competitorItems]
    .every((item) => item.skus.every((sku) => SKU_ID_PATTERN.test(sku.skuId)));
}

function parseCheckpoint(value: unknown, expectedRunId: string): CollectorCheckpoint {
  if (!isRecord(value)) throw new TypeError("Checkpoint must be a JSON object");
  if (value.checkpointFormatVersion !== 2) {
    throw new TypeError("Unsupported checkpoint format version; restart the collection run");
  }
  const parsedReport = collectorReportSchema.safeParse(value.report);
  if (value.schemaVersion !== 1
    || value.runId !== expectedRunId
    || typeof value.jobHash !== "string"
    || !JOB_HASH_PATTERN.test(value.jobHash)
    || !isPhase(value.phase)
    || !isUniqueNonEmptyStringArray(value.completedOwnListingIds)
    || !isUniqueNonEmptyStringArray(value.completedPlatformItemIds)
    || !isCompletedSkuKeyArray(value.completedSkuKeys)
    || !parsedReport.success
    || parsedReport.data.runId !== expectedRunId
    || !reportUsesCurrentSkuIds(parsedReport.data)
    || !isEvidenceManifest(value.evidenceManifest)
    || !isValidIdentityAliases(value.identityAliases)) {
    throw checkpointValidationError();
  }
  return {
    schemaVersion: 1,
    checkpointFormatVersion: 2,
    runId: value.runId,
    jobHash: value.jobHash,
    phase: value.phase,
    completedOwnListingIds: value.completedOwnListingIds,
    completedPlatformItemIds: value.completedPlatformItemIds,
    completedSkuKeys: value.completedSkuKeys,
    report: parsedReport.data,
    evidenceManifest: value.evidenceManifest,
    identityAliases: value.identityAliases
  };
}

function assertSafeRunId(runId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId) || runId === "." || runId === "..") {
    throw new TypeError("Checkpoint run ID must be a safe path segment");
  }
}

export class AtomicCheckpointStore {
  private readonly rootDirectory: string;

  constructor(rootDirectory: string) {
    this.rootDirectory = rootDirectory;
  }

  pathFor(runId: string): string {
    assertSafeRunId(runId);
    return join(this.rootDirectory, runId, "checkpoint.json");
  }

  async load(runId: string): Promise<CollectorCheckpoint | null> {
    try {
      const serialized = await readFile(this.pathFor(runId), "utf8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(serialized);
      } catch {
        throw checkpointValidationError();
      }
      return parseCheckpoint(parsed, runId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async save(runId: string, state: CollectorCheckpoint): Promise<void> {
    if (state.runId !== runId) {
      throw new TypeError("Checkpoint run ID does not match its storage key");
    }

    const validatedState = parseCheckpoint(state, runId);
    const checkpointPath = this.pathFor(runId);
    const runDirectory = dirname(checkpointPath);
    await mkdir(runDirectory, { recursive: true });

    const temporaryPath = join(runDirectory, `.checkpoint-${randomUUID()}.tmp`);
    try {
      await writeFile(temporaryPath, `${JSON.stringify(validatedState)}\n`, { encoding: "utf8", flag: "wx" });
      await rename(temporaryPath, checkpointPath);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }

  async remove(runId: string): Promise<void> {
    await rm(this.pathFor(runId), { force: true });
  }
}
